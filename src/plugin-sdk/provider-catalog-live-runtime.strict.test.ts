import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildLiveModelProviderConfig,
  buildOpenAICompatibleLiveModelProviderConfig,
  buildOpenAICompatibleProviderFamilyCatalog,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "./provider-catalog-live-runtime.js";

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
