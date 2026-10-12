import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import * as pluginLoader from "../plugins/loader.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createFixture } from "./control-ui-session-pr-access.test-support.js";
import { createRequestGatewayMethodRegistry } from "./server-methods.js";
import { loadGatewayPlugins } from "./server-plugins.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["in-process", "bound"] as const)(
  "resolves GitHub accounts through the %s trusted runtime and retains its lifetime",
  async (mode) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { GH_TOKEN: undefined, GITHUB_TOKEN: undefined } },
      async () => {
        const fixture = await createFixture("operator.read");
        const cfg = {
          ...fixture.cfg,
          gateway: {
            ...fixture.cfg.gateway,
            controlUi: { github: { token: "synthetic-github-lookup-token" } },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const methods = createRequestGatewayMethodRegistry();
        fixture.context.getGatewayMethodRegistry = () => methods;
        let runtime = createPluginRuntime();
        let retireGateway: (() => void) | undefined;
        if (mode === "bound") {
          const loader = vi
            .spyOn(pluginLoader, "loadOpenClawPlugins")
            .mockImplementation((options = {}) => {
              runtime = createPluginRuntime(options.runtimeOptions);
              return createEmptyPluginRegistry();
            });
          try {
            retireGateway = loadGatewayPlugins({
              cfg,
              autoEnabledReasons: {},
              baseMethods: [],
              loadIntent: "startup",
              pluginIds: ["visitor-access"],
              pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
                plugins: [{ id: "visitor-access" }],
              }),
              resolveGatewayContext: () => fixture.context,
            }).retireGatewayRuntimeBindings;
          } finally {
            loader.mockRestore();
          }
        }
        const plugins = createPluginRegistry({
          runtime,
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "visitor-access", origin: "bundled" });
        const untrusted = createPluginRecord({ id: "untrusted-lookup", origin: "workspace" });
        const resolve = plugins.createApi(record, { config: cfg }).runtime.gateway
          .resolveGitHubAccount!;
        const untrustedResolve = plugins.createApi(untrusted, { config: cfg }).runtime.gateway
          .resolveGitHubAccount!;
        plugins.registry.plugins.push(record, untrusted);
        const scope = {
          context: fixture.context,
          client: fixture.client,
          isWebchatConnect: () => false,
          pluginId: record.id,
          pluginOrigin: "bundled" as const,
        };
        const lookup = async (login = " Visitor ", signal?: AbortSignal) =>
          await withPluginRuntimeGatewayRequestScope(scope, () => resolve({ login, signal }));
        const fetcher = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", fetcher);
        try {
          await expect(
            withPluginRuntimeGatewayRequestScope(scope, () =>
              untrustedResolve({ login: "visitor" }),
            ),
          ).rejects.toThrow(/trusted official/);
          expect(fetcher).not.toHaveBeenCalled();
          fetcher.mockResolvedValue(
            Response.json({ id: 42, login: "Current-Visitor", email: "unused@example.test" }),
          );
          await expect(lookup()).resolves.toEqual({ accountId: 42, login: "Current-Visitor" });
          expect(fetcher).toHaveBeenCalledTimes(1);
          expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.github.com/users/Visitor");
          expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
            "Bearer synthetic-github-lookup-token",
          );
          fetcher.mockClear();
          await expect(lookup("../invalid")).resolves.toMatchObject({ error: { statusCode: 400 } });
          expect(fetcher).not.toHaveBeenCalled();

          for (const [status, statusCode] of [
            [404, 404],
            [503, 502],
            [403, 403],
            [401, 401],
          ] as const) {
            fetcher
              .mockClear()
              .mockResolvedValue(Response.json({ message: "private upstream body" }, { status }));
            await expect(lookup()).resolves.toMatchObject({
              error: { statusCode, credentialConfigured: true },
            });
            expect(fetcher).toHaveBeenCalledTimes(1);
          }
          for (const body of [
            { id: 0, login: "visitor" },
            { id: Number.MAX_SAFE_INTEGER + 1, login: "visitor" },
            { id: 42, login: "invalid/login" },
          ]) {
            fetcher.mockClear().mockResolvedValue(Response.json(body));
            await expect(lookup()).resolves.toMatchObject({ error: { statusCode: 502 } });
          }
          fetcher.mockClear().mockRejectedValue(new Error("private network detail"));
          await expect(lookup()).resolves.toMatchObject({
            error: { statusCode: 502, message: "Could not reach GitHub" },
          });

          for (const credentialConfigured of [true, false]) {
            setRuntimeConfigSnapshot(credentialConfigured ? cfg : fixture.cfg);
            const quotaFetch = vi.fn<typeof fetch>().mockResolvedValue(
              Response.json(
                { message: "private quota body" },
                {
                  status: credentialConfigured ? 403 : 429,
                  headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "2000000000" },
                },
              ),
            );
            vi.stubGlobal("fetch", quotaFetch);
            await expect(lookup()).resolves.toMatchObject({
              error: { statusCode: 429, retryAtMs: 2_000_000_000_000, credentialConfigured },
            });
            expect(quotaFetch).toHaveBeenCalledTimes(1);
          }
          setRuntimeConfigSnapshot(cfg);
          const entered = createDeferredCore<AbortSignal>();
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(
              (_url, init) =>
                new Promise((_resolve, reject) => {
                  const signal = init?.signal;
                  if (!signal) {
                    throw new Error("Expected lookup cancellation signal");
                  }
                  signal.addEventListener("abort", () => reject(new Error("Request aborted")), {
                    once: true,
                  });
                  entered.resolve(signal);
                }),
            ),
          );
          const cancellation = new AbortController();
          const pending = lookup("visitor", cancellation.signal);
          const rejected = expect(pending).rejects.toThrow();
          const requestSignal = await entered.promise;
          cancellation.abort(new Error("Synthetic service stopped"));
          await rejected;
          expect(requestSignal.aborted).toBe(true);

          const returning = createDeferredCore();
          const response = createDeferredCore<Response>();
          vi.stubGlobal(
            "fetch",
            vi.fn<typeof fetch>(async () => {
              returning.resolve();
              return await response.promise;
            }),
          );
          const retiring = expect(lookup()).rejects.toThrow();
          await returning.promise;
          if (retireGateway) {
            retireGateway();
          } else {
            plugins.rollbackPluginGlobalSideEffects(record.id, record);
          }
          response.resolve(Response.json({ id: 42, login: "Visitor" }));
          await retiring;
          await expect(lookup()).rejects.toThrow();
        } finally {
          retireGateway?.();
          plugins.rollbackPluginGlobalSideEffects(record.id, record);
          plugins.rollbackPluginGlobalSideEffects(untrusted.id, untrusted);
          await fixture.close();
          await fixture.removeSessions();
        }
      },
    );
  },
);
