import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../src/agents/agent-scope.js";
import { evaluateAttemptDecisionToolPrefilter } from "../src/agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
import { acquireAgentRunPreparedModelRuntime } from "../src/agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../src/agents/prepared-model-runtime.test-support.js";
import { createDecisionTool } from "../src/agents/tools/decision-tool.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { prepareDecisionProviderReload } from "../src/decisions/runtime.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { runPluginRegisterSyncInRegistry } from "../src/plugins/loader-module-runtime.js";
import { createPluginRecord } from "../src/plugins/loader-records.js";
import { resetPluginLoaderTestStateForTest } from "../src/plugins/loader.test-fixtures.js";
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../src/plugins/plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../src/plugins/plugin-metadata-snapshot.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createColdPluginHermeticEnv } from "../src/plugins/test-helpers/cold-plugin-fixtures.js";
import { clearSecretsRuntimeSnapshotState } from "../src/secrets/runtime-state.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { withEnvAsync } from "../src/test-utils/env.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";
import { VERSION } from "../src/version.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("lets admitted TypeSafe work finish after opt-out while preserving independent final-I/O guards", async () => {
  const root = roots.make("decision-typesafe-admission-");
  const emptyBundled = path.join(root, "bundled");
  fs.mkdirSync(emptyBundled);
  const workspaceDir = path.join(root, "workspace");
  const loading = createDeferredCore();
  const release = createDeferredCore();
  // Prepare the real client outside the request deadline; suspend only its lazy import.
  const original = await vi.importActual("../extensions/typesafe/src/client.js");
  vi.doMock("../extensions/typesafe/src/client.js", async () => {
    loading.resolve();
    await release.promise;
    return original;
  });
  let requests = 0;
  const server = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((req, res) => {
        requests++;
        req.resume();
        req.on("end", () => {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              model: "kev-latest",
              answers: {
                missing_request_context: { type: "noul", noul: 0.05 },
                next_response_needs_tools: { type: "noul", noul: 0.05 },
              },
              usage: { input_tokens: 40, output_tokens: 2 },
              latency_ms: 1,
            }),
          );
        });
      }),
  });
  const config = (decisionAssistance: boolean): OpenClawConfig => ({
    agents: {
      defaults: {
        experimental: { decisionAssistance },
        decisionModel: "typesafe/kev-latest",
        workspace: workspaceDir,
      },
    },
    plugins: {
      load: { paths: [fileURLToPath(new URL("../extensions/typesafe", import.meta.url))] },
      slots: { memory: "none" },
      entries: {
        typesafe: { enabled: true, config: { baseUrl: "http://localhost:" + server.claim.port } },
      },
    },
  });
  try {
    await withEnvAsync(
      {
        ...createColdPluginHermeticEnv(root, { bundledPluginsDir: emptyBundled }),
        OPENCLAW_COMPATIBILITY_HOST_VERSION: VERSION,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        const metadata = resolvePluginMetadataSnapshot({
          config: config(true),
          env: process.env,
          workspaceDir,
        });
        const manifest = metadata.byPluginId.get("typesafe");
        if (!manifest) {
          throw new Error("Missing source TypeSafe metadata");
        }
        const builder = createTestPluginRegistry(
          createPluginRuntimeMock({
            config: { current: () => getRuntimeConfigSnapshot() ?? config(true) },
          }),
        );
        const record = createPluginRecord({
          ...manifest,
          enabled: true,
          configSchema: Boolean(manifest.configSchema),
        });
        let authorityError: Error | undefined;
        const turn = (cfg: OpenClawConfig) =>
          evaluateAttemptDecisionToolPrefilter({
            config: cfg,
            agentId: "main",
            supportsTurnScopedToolRestrictions: true,
            assertActive: () => {
              if (authorityError) {
                throw authorityError;
              }
            },
            userMessage: "Hello",
            messages: [],
            signal: new AbortController().signal,
          });
        try {
          const { default: typesafe } = await import("../extensions/typesafe/index.js");
          const api = builder.createApi(record, { config: config(true) });
          runPluginRegisterSyncInRegistry(
            (registration) => typesafe.register(registration),
            api,
            builder.registry,
            record.id,
          );
          builder.registry.plugins.push(record);
          setActivePluginRegistry(builder.registry);
          const initial = config(true);
          setRuntimeConfigSnapshot(initial);
          // Keep host policy initialization outside the 500 ms consumer budget;
          // the suspended import and DNS below exercise admission, not cold setup.
          providerHttp.resolveProviderHttpRequestConfigWithOriginTrust({
            provider: "typesafe",
            baseUrl: "http://localhost:" + server.claim.port + "/v1",
            defaultBaseUrl: "https://api.typesafe.ai/v1",
          });
          // Retain Vitest imports for deterministic I/O gates, but use the discovered
          // source identity and real prepared catalog/auth required by the V2 owner.
          await import("../src/agents/decision-inference.js");
          // Keep the lease until the assertions finish: a standalone warm-up that
          // immediately releases it retires the owner and makes admission cold again.
          await using prepared = await acquireAgentRunPreparedModelRuntime(
            {
              config: initial,
              agentId: "main",
              agentDir: resolveAgentDir(initial, "main"),
              workspaceDir,
              loadRuntimePlugins: true,
              runtimePluginSelections: [
                { provider: "typesafe", modelId: "kev-latest", agentId: "main" },
              ],
            },
            { catalogMode: "static", pluginMetadataSnapshot: metadata },
          );
          expect(prepared.snapshot.pluginRegistry?.providers).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ pluginId: record.id, source: record.source }),
            ]),
          );
          expect(prepared.snapshot.modelCatalog.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ provider: "typesafe", id: "kev-latest" }),
            ]),
          );
          const started = performance.now();
          const pending = turn(initial);
          await Promise.race([
            loading.promise,
            pending.then((result) => {
              throw new Error(
                `TypeSafe settled before client admission: ${JSON.stringify(result)}`,
              );
            }),
          ]);
          const clientReadyMs = performance.now() - started;
          const disabledConfig = config(false);
          setRuntimeConfigSnapshot(disabledConfig);
          release.resolve();
          const admitted = await pending;
          const admittedRequests = requests;
          const skipped = await turn(disabledConfig);
          expect(skipped).toMatchObject({ status: "skipped", shouldPruneTools: false });
          expect(requests).toBe(admittedRequests);
          const allowedConfig = config(true);
          setRuntimeConfigSnapshot(allowedConfig);
          const allowed = await turn(allowedConfig);
          console.info(
            JSON.stringify({
              admittedRequests,
              allowedRequests: requests - admittedRequests,
              admitted: admitted.status,
              clientReadyMs,
              elapsedMs: performance.now() - started,
              nextTurn: skipped.status,
              allowed: allowed.status,
            }),
          );
          expect(allowed).toMatchObject({ status: "proposed", shouldPruneTools: true });
          expect(requests - admittedRequests).toBe(1);
          expect(admitted).toMatchObject({ status: "proposed", shouldPruneTools: true });
          expect(admittedRequests).toBe(1);

          // Hold real DNS preparation. Labs opt-out permits admitted I/O; independent
          // guards still reject it. Restoring config during cleanup must not erase an
          // observed authority failure or poison shared provider health.
          const guardedFetch = providerHttp.fetchWithProviderHttpGuard;
          for (const change of [
            "optout",
            "model",
            "authority",
            "provider-config",
            "secrets",
          ] as const) {
            const resolving = createDeferredCore();
            const resolved = createDeferredCore();
            setRuntimeConfigSnapshot(config(true));
            const localConfig = getRuntimeConfigSnapshot()!;
            const before = requests;
            const originalError = new Error("synthetic authority closed");
            const intercepted = vi
              .spyOn(providerHttp, "fetchWithProviderHttpGuard")
              .mockImplementation((params) => {
                const lookup = params.lookupFn;
                if (!lookup) {
                  throw new Error("expected TypeSafe loopback lookup");
                }
                return guardedFetch({
                  ...params,
                  lookupFn: async (...args) => {
                    resolving.resolve();
                    await resolved.promise;
                    return await lookup(...args);
                  },
                  beforeRequest: () => {
                    try {
                      params.beforeRequest?.();
                    } catch (error) {
                      setRuntimeConfigSnapshot(localConfig);
                      authorityError = undefined;
                      throw error;
                    }
                  },
                });
              });
            try {
              const pendingTurn = turn(localConfig);
              const captured = pendingTurn.then(
                (result) => ({ result }),
                (error: unknown) => ({ error }),
              );
              await Promise.race([
                resolving.promise,
                captured.then((outcome) => {
                  throw new Error(
                    `TypeSafe settled before ${change} DNS admission: ${JSON.stringify(outcome)}`,
                    { cause: "error" in outcome ? outcome.error : undefined },
                  );
                }),
              ]);
              if (change === "authority") {
                authorityError = originalError;
              } else if (change === "provider-config") {
                setRuntimeConfigSnapshot({
                  ...localConfig,
                  plugins: {
                    ...localConfig.plugins,
                    entries: {
                      typesafe: {
                        enabled: true,
                        config: { baseUrl: "http://127.0.0.1:" + server.claim.port },
                      },
                    },
                  },
                });
              } else if (change === "secrets") {
                clearSecretsRuntimeSnapshotState();
                setRuntimeConfigSnapshot(localConfig);
              } else {
                setRuntimeConfigSnapshot({
                  ...localConfig,
                  agents: {
                    defaults: {
                      ...localConfig.agents!.defaults,
                      ...(change === "model"
                        ? { decisionModel: "typesafe/changed-model" }
                        : { experimental: { decisionAssistance: false } }),
                    },
                  },
                });
              }
              resolved.resolve();
              const outcome = await captured;
              if (change === "authority") {
                expect(outcome).toEqual({ error: originalError });
              } else if (change === "optout") {
                expect(outcome).toMatchObject({
                  result: { status: "proposed", shouldPruneTools: true },
                });
              } else {
                expect(outcome).toMatchObject({
                  result: {
                    shouldPruneTools: false,
                    status: "unavailable",
                  },
                });
              }
              expect(requests - before).toBe(change === "optout" ? 1 : 0);
              if (change === "optout") {
                expect(
                  builder.registry.decisionProviders[0]!.host.inspect(localConfig),
                ).toMatchObject({
                  callable: true,
                  activeRequests: 0,
                });
              }
              console.info(
                JSON.stringify({ preparationRevocation: change, requests: requests - before }),
              );
            } finally {
              resolved.resolve();
              authorityError = undefined;
              intercepted.mockRestore();
            }
          }
          const optedOut = config(false);
          setRuntimeConfigSnapshot(optedOut);
          const explicit = createDecisionTool("main", { config: optedOut });
          expect(explicit).not.toBeNull();
          const beforeExplicit = requests;
          const evaluation = await explicit!.execute("explicit", {
            state: "hello",
            questions: {
              missing_request_context: { type: "boolean" },
              next_response_needs_tools: { type: "boolean" },
            },
          });
          expect(evaluation.details).toMatchObject({ status: "ok" });
          expect(requests - beforeExplicit).toBe(1);
          console.info(JSON.stringify({ explicitLabsOffRequests: requests - beforeExplicit }));
        } finally {
          release.resolve();
          prepareDecisionProviderReload(builder.registry, new Set([record.id]));
          await getPluginInstance(record)?.dispose();
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          resetPluginLoaderTestStateForTest();
          clearRuntimeConfigSnapshot();
        }
      },
    );
  } finally {
    release.resolve();
    vi.doUnmock("../extensions/typesafe/src/client.js");
    await server.releaseListener();
    await server.claim.release();
  }
});
