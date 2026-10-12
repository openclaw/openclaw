import { createServer } from "node:http";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { expect, it, vi } from "vitest";
import { evaluateAttemptDecisionToolPrefilter } from "../src/agents/embedded-agent-runner/run/attempt-decision-prefilter.js";
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
import { getPluginInstance } from "../src/plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../src/plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../src/plugins/runtime.js";
import { clearSecretsRuntimeSnapshotState } from "../src/secrets/runtime-state.js";
import { createDeferredCore } from "../src/shared/deferred.js";
import { reserveTestPortListener } from "../src/test-utils/port-claims.js";

it("lets admitted TypeSafe work finish after opt-out while preserving independent final-I/O guards", async () => {
  const loading = createDeferredCore();
  const release = createDeferredCore();
  // Only suspend the cold import; the public plugin, client and guarded transport run unchanged.
  vi.doMock("../extensions/typesafe/src/client.js", async (importOriginal) => {
    const original = await importOriginal();
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
      defaults: { experimental: { decisionAssistance }, decisionModel: "typesafe/kev-latest" },
    },
    plugins: {
      entries: { typesafe: { config: { baseUrl: "http://localhost:" + server.claim.port } } },
    },
  });
  const builder = createTestPluginRegistry(
    createPluginRuntimeMock({
      config: { current: () => getRuntimeConfigSnapshot() ?? config(true) },
    }),
  );
  const record = createPluginRecord({
    id: "typesafe",
    source: "/bundled/typesafe/index.ts",
    origin: "bundled",
    enabled: true,
    configSchema: false,
    contracts: { decisionProviders: ["typesafe"] },
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
    const pending = turn(initial);
    await loading.promise;
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
    const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
    for (const change of ["optout", "model", "authority", "provider-config", "secrets"] as const) {
      const resolving = createDeferredCore();
      const resolved = createDeferredCore();
      const localConfig = config(true);
      setRuntimeConfigSnapshot(localConfig);
      const before = requests;
      const originalError = new Error("synthetic authority closed");
      const intercepted = vi
        .spyOn(ssrfRuntime, "fetchWithSsrFGuard")
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
        await resolving.promise;
        if (change === "authority") {
          authorityError = originalError;
        } else if (change === "provider-config") {
          setRuntimeConfigSnapshot({
            ...localConfig,
            plugins: {
              entries: {
                typesafe: { config: { baseUrl: "http://127.0.0.1:" + server.claim.port } },
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
              reason:
                change === "provider-config" || change === "secrets" ? "retiring" : "disabled",
            },
          });
        }
        expect(requests - before).toBe(change === "optout" ? 1 : 0);
        if (change === "optout") {
          expect(builder.registry.decisionProviders[0]!.host.inspect(localConfig)).toMatchObject({
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
    resetPluginRuntimeStateForTest();
    clearRuntimeConfigSnapshot();
    vi.doUnmock("../extensions/typesafe/src/client.js");
    await server.releaseListener();
    await server.claim.release();
  }
});
