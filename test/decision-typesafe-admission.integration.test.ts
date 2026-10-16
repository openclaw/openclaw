import { createServer } from "node:http";
import { resolveProviderHttpRequestConfigWithOriginTrust } from "openclaw/plugin-sdk/provider-http";
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
  const proposed = { status: "proposed", shouldPruneTools: true };
  // Exclude cold client/policy setup from the consumer's 500 ms budget.
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
  const config = (
    decisionAssistance: boolean,
    { hostname = "localhost", decisionModel = "typesafe/kev-latest" } = {},
  ): OpenClawConfig => ({
    agents: { defaults: { experimental: { decisionAssistance }, decisionModel } },
    plugins: {
      entries: { typesafe: { config: { baseUrl: `http://${hostname}:${server.claim.port}` } } },
    },
  });
  const builder = createTestPluginRegistry(
    createPluginRuntimeMock({
      config: { current: () => getRuntimeConfigSnapshot() ?? config(true) },
    }),
  );
  const publish = (cfg: OpenClawConfig) => {
    setRuntimeConfigSnapshot(cfg);
    return cfg;
  };
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
    const initial = publish(config(true));
    resolveProviderHttpRequestConfigWithOriginTrust({
      provider: "typesafe",
      baseUrl: "http://localhost:" + server.claim.port + "/v1",
      defaultBaseUrl: "https://api.typesafe.ai/v1",
    });
    const pending = turn(initial);
    await loading.promise;
    const disabledConfig = publish(config(false));
    release.resolve();
    const admitted = await pending;
    const admittedRequests = requests;
    const skipped = await turn(disabledConfig);
    expect(skipped).toMatchObject({ status: "skipped", shouldPruneTools: false });
    expect(requests).toBe(admittedRequests);
    expect(await turn(publish(config(true)))).toMatchObject(proposed);
    expect(requests - admittedRequests).toBe(1);
    expect(admitted).toMatchObject(proposed);
    expect(admittedRequests).toBe(1);

    // Suspend DNS to revoke authority at final I/O, then restore without erasing failures.
    const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
    for (const [change, nextConfig, reason] of [
      ["optout", config(false), null],
      ["model", config(true, { decisionModel: "typesafe/changed-model" }), "disabled"],
      ["authority", undefined, null],
      ["provider-config", config(true, { hostname: "127.0.0.1" }), "retiring"],
      ["secrets", undefined, "retiring"],
    ] as const) {
      const resolving = createDeferredCore();
      const resolved = createDeferredCore();
      const localConfig = publish(config(true));
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
        } else {
          if (change === "secrets") {
            clearSecretsRuntimeSnapshotState();
          }
          publish(nextConfig ?? localConfig);
        }
        resolved.resolve();
        const outcome = await captured;
        if (change === "authority") {
          expect(outcome).toEqual({ error: originalError });
        } else {
          expect(outcome).toMatchObject({
            result: reason ? { shouldPruneTools: false, status: "unavailable", reason } : proposed,
          });
        }
        expect(requests - before).toBe(change === "optout" ? 1 : 0);
        if (change === "optout") {
          expect(builder.registry.decisionProviders[0]!.host.inspect(localConfig)).toMatchObject({
            callable: true,
            activeRequests: 0,
          });
        }
      } finally {
        resolved.resolve();
        authorityError = undefined;
        intercepted.mockRestore();
      }
    }
    const explicit = createDecisionTool("main", { config: publish(config(false)) });
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
