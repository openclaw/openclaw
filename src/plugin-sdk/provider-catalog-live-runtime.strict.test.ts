import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleProviderCatalog,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  getCachedLiveProviderModelRows,
  getCachedUpstreamProviderCatalog,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";
import { getCachedLiveCatalogValue } from "./provider-catalog-shared.js";

const { fetchGuard } = vi.hoisted(() => ({ fetchGuard: vi.fn<LiveModelCatalogFetchGuard>() }));
vi.mock("./ssrf-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ssrf-runtime.js")>()),
  fetchWithSsrFGuard: fetchGuard,
}));

const seed: ModelProviderConfig = {
  baseUrl: "https://catalog.example/v1",
  api: "openai-completions",
  models: [
    {
      id: "known",
      name: "Known",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
  ],
};

const catalogParams = {
  providerId: "demo",
  endpoint: `${seed.baseUrl}/models`,
  providerConfig: seed,
  models: seed.models,
  apiKey: "synthetic-key",
  fetchGuard,
};
const projectRows = (rows: readonly unknown[], fallback: ModelProviderConfig) =>
  rows.length ? fallback.models : [];

afterEach(() => {
  vi.useRealTimers();
  clearLiveCatalogCacheForTests();
  fetchGuard.mockReset();
});

describe("strict catalog acquisition", () => {
  it.each(["upstream", "rows", "ids"] as const)(
    "%s keeps a shared acquisition alive after one consumer cancels",
    async (kind) => {
      const started = createDeferredCore<AbortSignal | undefined>();
      const responseReady = createDeferredCore();
      const release = vi.fn(async () => {});
      fetchGuard.mockImplementation(async ({ signal, url }) => {
        started.resolve(signal);
        await responseReady.promise;
        return {
          response: Response.json(
            kind === "upstream"
              ? { alpha: { id: "alpha", models: {} }, beta: { id: "beta", models: {} } }
              : { data: [{ id: "known" }] },
          ),
          finalUrl: url,
          release,
        };
      });
      const acquire = (signal: AbortSignal, providerId = "alpha"): Promise<unknown> => {
        if (kind === "upstream") {
          return getCachedUpstreamProviderCatalog({
            endpoint: catalogParams.endpoint,
            providerId,
            fetchGuard,
            signal,
          });
        }
        if (kind === "rows") {
          return getCachedLiveProviderModelRows({ ...catalogParams, signal });
        }
        return buildLiveModelProviderConfig({
          ...catalogParams,
          discoveryMode: "strict",
          signal,
        });
      };
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = acquire(firstController.signal);
      const second = acquire(secondController.signal, "beta");
      const settled = Promise.allSettled([first, second]);
      try {
        const acquisitionSignal = await started.promise;
        expect(fetchGuard).toHaveBeenCalledOnce();
        const reason = { source: "first catalog consumer closed" };
        firstController.abort(reason);
        expect(acquisitionSignal?.aborted).toBe(false);
        responseReady.resolve();
        await expect(first).rejects.toBe(reason);
        const expected =
          kind === "upstream"
            ? { id: "beta", models: {} }
            : kind === "rows"
              ? [{ id: "known" }]
              : { ...seed, apiKey: catalogParams.apiKey };
        await expect(second).resolves.toEqual(expected);
        await expect(acquire(secondController.signal, "beta")).resolves.toEqual(expected);
        expect(fetchGuard).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
      } finally {
        responseReady.resolve();
        firstController.abort();
        secondController.abort();
        await settled;
      }
    },
  );

  it("preserves available HTTP catalogs and releases abandoned bodies before teardown", async () => {
    for (const mode of ["shared", "abandoned", "capacity"] as const) {
      const responseReady = createDeferredCore<ServerResponse>();
      const firstChunkRead = createDeferredCore();
      const responseClosed = createDeferredCore();
      const released = createDeferredCore();
      let response: ServerResponse | undefined;
      let requests = 0;
      const reserved = await reserveTestPortListener({
        offsets: [0],
        createListener: () =>
          createServer((_request, reply) => {
            requests += 1;
            response = reply;
            reply.once("close", () => responseClosed.resolve());
            reply.setHeader("content-type", "application/json");
            reply.write('{"data":[');
            responseReady.resolve(reply);
          }),
      });
      const controllers = [new AbortController(), new AbortController()];
      const pending: Array<Promise<unknown>> = [];
      const heldCompletion = createDeferredCore<string>();
      const held =
        mode === "capacity"
          ? Array.from({ length: 100 }, (_, index) =>
              getCachedLiveCatalogValue({
                keyParts: ["held-http-catalog", index],
                load: () => heldCompletion.promise,
              }),
            )
          : [];
      const releases: Array<() => Promise<void>> = [];
      const restoreReaders: Array<() => void> = [];
      let acquisitionSignal: AbortSignal | undefined;
      const observedGuard: LiveModelCatalogFetchGuard = async (params) => {
        acquisitionSignal = params.signal;
        const result = await fetchWithSsrFGuard({
          ...params,
          requireHttps: false,
          policy: { allowPrivateNetwork: true, hostnameAllowlist: ["127.0.0.1"] },
          dispatcherPolicy: { mode: "direct" },
        });
        releases.push(result.release);
        const body = result.response.body;
        if (!body) {
          throw new Error("Expected the real catalog response body");
        }
        const getReader = body.getReader.bind(body);
        const readerSpy = vi.spyOn(body, "getReader").mockImplementation(() => {
          const reader = getReader();
          const read = reader.read.bind(reader);
          const readSpy = vi.spyOn(reader, "read").mockImplementation(async () => {
            const chunk = await read();
            if (!chunk.done && chunk.value.byteLength > 0) {
              firstChunkRead.resolve();
            }
            return chunk;
          });
          restoreReaders.push(() => readSpy.mockRestore());
          return reader;
        });
        restoreReaders.push(() => readerSpy.mockRestore());
        return {
          ...result,
          release: async () => {
            await result.release();
            released.resolve();
          },
        };
      };
      fetchGuard.mockImplementation(observedGuard);
      const baseUrl = `http://127.0.0.1:${reserved.claim.port}/${mode}`;
      const acquire = (signal: AbortSignal) =>
        mode === "capacity"
          ? buildOpenAICompatibleProviderCatalog({
              providerId: "demo",
              buildProvider: () => ({ ...seed, baseUrl }),
              discoveryMode: "strict",
              ctx: {
                config: {},
                env: {},
                signal,
                resolveProviderApiKey: () => ({ apiKey: "fixture-key" }),
                resolveProviderAuth: () => {
                  throw new Error("Do not reselect auth");
                },
              },
            })
          : getCachedLiveProviderModelRows({
              providerId: "demo",
              endpoint: `${baseUrl}/models`,
              requireHttps: false,
              signal,
              fetchGuard: observedGuard,
            });
      try {
        pending.push(acquire(controllers[0]!.signal));
        if (mode === "shared") {
          pending.push(acquire(controllers[1]!.signal));
        }
        // Attach both rejection handlers before the first caller can abort shared I/O.
        const settled = Promise.allSettled(pending);
        await Promise.race([
          firstChunkRead.promise,
          pending[0]!.then((value) => {
            if (mode === "capacity") {
              expect(value).toMatchObject({ outcomes: [{ provider: "demo", status: "ready" }] });
            }
            throw new Error("Catalog completed before the held body was read");
          }),
        ]);
        const reply = await responseReady.promise;
        if (mode === "capacity") {
          reply.end('{"id":"known"}]}');
          const expected = {
            provider: { models: seed.models },
            outcomes: [{ provider: "demo", status: "ready" }],
          };
          await expect(pending[0]).resolves.toMatchObject(expected);
          await expect(acquire(controllers[0]!.signal)).resolves.toMatchObject(expected);
          expect(acquisitionSignal?.aborted).toBe(false);
        } else {
          const reason = new Error("catalog consumer closed");
          controllers[0]!.abort(reason);
          await expect(pending[0]).rejects.toBe(reason);
          expect(acquisitionSignal?.aborted).toBe(mode === "abandoned");
          if (mode === "shared") {
            reply.end('{"id":"known"}]}');
            await expect(pending[1]).resolves.toEqual([{ id: "known" }]);
          } else {
            await responseClosed.promise;
            expect(reply.writableFinished).toBe(false);
          }
        }
        await released.promise;
        await settled;
        expect(requests).toBe(1);
      } finally {
        try {
          controllers.forEach((controller) => controller.abort());
          heldCompletion.resolve("settled");
          response?.destroy();
          reserved.listener.closeAllConnections();
          await Promise.allSettled([...pending, ...held]);
          await Promise.all(releases.map((release) => release()));
        } finally {
          restoreReaders.forEach((restore) => restore());
          try {
            await reserved.releaseListener();
          } finally {
            await reserved.claim.release();
          }
        }
      }
    }
  });

  it.each(["single", "family"] as const)(
    "%s adapter cancels its underlying acquisition",
    async (kind) => {
      const controller = new AbortController();
      const started = createDeferredCore<AbortSignal>();
      fetchGuard.mockImplementation(({ signal }) => {
        if (!signal) {
          throw new Error("Expected acquisition signal");
        }
        const cancelled = createDeferredCore<never>();
        started.resolve(signal);
        signal.addEventListener("abort", () => cancelled.reject(signal.reason), { once: true });
        return cancelled.promise;
      });
      const ctx = {
        config: {},
        env: {},
        signal: controller.signal,
        resolveProviderApiKey: () => ({ apiKey: "fixture-key" }),
        resolveProviderAuth: () => {
          throw new Error("Do not reselect auth");
        },
      };
      const pending =
        kind === "single"
          ? buildOpenAICompatibleProviderCatalog({
              ctx,
              providerId: "demo",
              buildProvider: () => seed,
              discoveryMode: "strict",
            })
          : buildOpenAICompatibleProviderFamilyCatalog({
              discoveryMode: "strict",
              credentialProviderId: "family",
              entries: [
                {
                  id: "demo",
                  label: "Demo",
                  baseUrl: seed.baseUrl,
                  models: seed.models,
                  buildProvider: () => seed,
                },
              ],
              staticCatalog: async () => ({ providers: {} }),
              augmentModelCatalog: () => [],
            }).catalog.run(ctx);
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      controller.abort(new Error("Catalog owner closed"));
      await expect(pending).resolves.toMatchObject({
        outcomes: [{ provider: "demo", status: "unavailable" }],
      });
      expect(signal.aborted).toBe(true);
      expect(fetchGuard).toHaveBeenCalledOnce();
    },
  );

  it.each(["ids", "projection", "openai-compatible"] as const)(
    "%s preserves failure, caches authoritative empty until expiry and supports bypass",
    async (projection) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(0);
      const release = vi.fn(async () => {});
      const failure = new Error("catalog transport unavailable");
      fetchGuard
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({
          response: Response.json({ data: [] }),
          finalUrl: `${seed.baseUrl}/models`,
          release,
        })
        .mockImplementation(async () => ({
          response: Response.json({ data: [{ id: "known" }] }),
          finalUrl: `${seed.baseUrl}/models`,
          release,
        }));
      const params = {
        discoveryMode: "strict" as const,
        providerId: "demo",
        providerConfig: seed,
        apiKey: "synthetic-key",
        fetchGuard,
      };
      const acquire = (ttlMs = 1_000) =>
        projection === "openai-compatible"
          ? buildOpenAICompatibleLiveModelProviderConfig({
              ...params,
              modelDiscovery: { ttlMs },
            })
          : buildLiveModelProviderConfig({
              ...params,
              ttlMs,
              endpoint: `${seed.baseUrl}/models`,
              models: seed.models,
              ...(projection === "projection"
                ? { projectRows: (rows: readonly unknown[]) => (rows.length ? seed.models : []) }
                : {}),
            });
      await expect(acquire()).rejects.toBe(failure);
      expect(fetchGuard).toHaveBeenCalledTimes(1);
      await expect(acquire()).resolves.toMatchObject({ models: [] });
      await expect(acquire()).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      vi.setSystemTime(999);
      await expect(acquire()).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      await expect(acquire(0)).resolves.toMatchObject({ models: seed.models });
      await expect(acquire()).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(3);
      vi.setSystemTime(1_000);
      await expect(acquire()).resolves.toMatchObject({ models: seed.models });
      await expect(acquire()).resolves.toMatchObject({ models: seed.models });
      expect(fetchGuard).toHaveBeenCalledTimes(4);
      expect(release).toHaveBeenCalledTimes(3);
    },
  );

  describe.each(["ids", "projection"] as const)("%s cache isolation", (kind) => {
    const projection = kind === "projection" ? projectRows : undefined;

    it.each([
      ["strict", false],
      ["advisory", false],
      ["strict", true],
      ["advisory", true],
    ] as const)("separates %s-first calls (concurrent: %s)", async (firstMode, concurrent) => {
      const held = createDeferredCore();
      const release = vi.fn(async () => {});
      fetchGuard.mockImplementation(async ({ url }) => {
        await held.promise;
        return { response: Response.json({ data: [] }), finalUrl: url, release };
      });
      const acquire = (mode: "strict" | "advisory") =>
        buildLiveModelProviderConfig({
          ...catalogParams,
          discoveryMode: mode === "strict" ? "strict" : undefined,
          projectRows: projection,
        });
      const secondMode = firstMode === "strict" ? "advisory" : "strict";
      const first = acquire(firstMode);
      if (!concurrent) {
        held.resolve();
        await first;
      }
      const second = acquire(secondMode);
      const startedRequests = fetchGuard.mock.calls.length;
      held.resolve();
      await expect(first).resolves.toMatchObject({
        models: firstMode === "strict" ? [] : seed.models,
      });
      await expect(second).resolves.toMatchObject({
        models: secondMode === "strict" ? [] : seed.models,
      });
      expect(startedRequests).toBe(2);
      await expect(acquire("strict")).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      await expect(acquire("advisory")).resolves.toMatchObject({ models: seed.models });
      await expect(acquire("strict")).resolves.toMatchObject({ models: [] });
      expect(fetchGuard).toHaveBeenCalledTimes(3);
      expect(release).toHaveBeenCalledTimes(3);
    });

    it.each(["auth", "endpoint", "provider", "kind", "custom"] as const)(
      "preserves %s isolation with custom key parts",
      async (scope) => {
        const release = vi.fn(async () => {});
        fetchGuard
          .mockResolvedValueOnce({
            response: Response.json({ data: [] }),
            finalUrl: catalogParams.endpoint,
            release,
          })
          .mockImplementation(async ({ url }) => ({
            response: Response.json({ data: [{ id: "known" }] }),
            finalUrl: url,
            release,
          }));
        const params = {
          ...catalogParams,
          discoveryMode: "strict" as const,
          discoveryApiKey: "synthetic-resolved-first",
          cacheKeyParts: ["shared-catalog"],
          projectRows: projection,
        };
        const changed = {
          ...params,
          ...(scope === "auth" ? { discoveryApiKey: "synthetic-resolved-second" } : {}),
          ...(scope === "endpoint" ? { endpoint: "https://other.example/v1/models" } : {}),
          ...(scope === "provider" ? { providerId: "other" } : {}),
          ...(scope === "kind" ? { projectRows: projection ? undefined : projectRows } : {}),
          ...(scope === "custom" ? { cacheKeyParts: ["other-catalog"] } : {}),
        };
        await expect(buildLiveModelProviderConfig(params)).resolves.toMatchObject({ models: [] });
        await expect(buildLiveModelProviderConfig(changed)).resolves.toMatchObject({
          models: seed.models,
        });
        await expect(buildLiveModelProviderConfig(changed)).resolves.toMatchObject({
          models: seed.models,
        });
        await expect(buildLiveModelProviderConfig(params)).resolves.toMatchObject({ models: [] });
        expect(fetchGuard).toHaveBeenCalledTimes(2);
        expect(release).toHaveBeenCalledTimes(2);
      },
    );
  });

  it("reprojects cached raw rows with the current fallback", async () => {
    const rows = [{ id: "known" }];
    fetchGuard.mockImplementation(async ({ url }) => ({
      response: Response.json({ data: rows }),
      finalUrl: url,
      release: async () => {},
    }));
    const params = {
      ...catalogParams,
      discoveryMode: "strict" as const,
      projectRows: (candidateRows: readonly unknown[], fallback: ModelProviderConfig) => {
        expect(candidateRows).toEqual(rows);
        return fallback.models;
      },
    };
    await expect(buildLiveModelProviderConfig(params)).resolves.toMatchObject({
      models: seed.models,
    });
    const models = seed.models.map((model) => ({
      ...model,
      name: "Updated",
      contextWindow: 256_000,
    }));
    await expect(buildLiveModelProviderConfig({ ...params, models })).resolves.toMatchObject({
      models,
    });
    expect(fetchGuard).toHaveBeenCalledOnce();
  });

  it("does not retain rows when the strict projector throws", async () => {
    const failure = new Error("catalog projection failed");
    fetchGuard
      .mockResolvedValueOnce({
        response: Response.json({ data: [] }),
        finalUrl: catalogParams.endpoint,
        release: async () => {},
      })
      .mockImplementation(async ({ url }) => ({
        response: Response.json({ data: [{ id: "known" }] }),
        finalUrl: url,
        release: async () => {},
      }));
    const acquire = () =>
      buildLiveModelProviderConfig({
        ...catalogParams,
        discoveryMode: "strict",
        projectRows: (rows, fallback) => {
          if (rows.length === 0) {
            throw failure;
          }
          return fallback.models;
        },
      });
    await expect(acquire()).rejects.toBe(failure);
    await expect(acquire()).resolves.toMatchObject({ models: seed.models });
    await expect(acquire()).resolves.toMatchObject({ models: seed.models });
    expect(fetchGuard).toHaveBeenCalledTimes(2);
  });

  it.each([401, 503])(
    "HTTP %s preserves a healthy family sibling and captured auth",
    async (status) => {
      const release = vi.fn(async () => {});
      fetchGuard.mockImplementation(async ({ url, init }) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer resolved-family-key");
        return {
          response: url.includes("unavailable")
            ? Response.json({}, { status })
            : Response.json({ data: [{ id: "known" }] }),
          finalUrl: url,
          release,
        };
      });
      const family = buildOpenAICompatibleProviderFamilyCatalog({
        discoveryMode: "strict",
        credentialProviderId: "family",
        entries: ["unavailable", "healthy"].map((id) => ({
          id,
          label: id,
          baseUrl: `https://${id}.example/v1`,
          models: seed.models,
          buildProvider: () => ({ ...seed, baseUrl: `https://${id}.example/v1` }),
        })),
        staticCatalog: async () => ({ providers: {} }),
        augmentModelCatalog: () => [],
      });
      const resolveProviderApiKey = vi.fn(() => ({
        apiKey: "family:profile",
        discoveryApiKey: "resolved-family-key",
        profileId: "family:profile",
      }));
      const resolveProviderAuth = vi.fn(() => {
        throw new Error("Do not reselect auth");
      });
      await expect(
        family.catalog.run({ config: {}, env: {}, resolveProviderApiKey, resolveProviderAuth }),
      ).resolves.toMatchObject({
        providers: { healthy: { models: seed.models } },
        outcomes: [
          {
            provider: "unavailable",
            profileId: "family:profile",
            status: status === 401 ? "auth-rejected" : "unavailable",
            ...(status === 401 ? { rejectionScope: "catalog" } : {}),
          },
          { provider: "healthy", profileId: "family:profile", status: "ready" },
        ],
      });
      expect(resolveProviderApiKey).toHaveBeenCalledOnce();
      expect(resolveProviderAuth).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(2);
    },
  );
});
