import path from "node:path";

const NON_ISOLATED_RESPONSES_PROBE_KEY = "openclaw.nonIsolatedResponsesProbe";

/** Builds a real Responses producer and its next-file teardown observer. */
export function responsesProducerFixtureFiles(repoRoot: string): Record<string, string> {
  const source = (name: string) => JSON.stringify(path.join(repoRoot, "src", name));
  return {
    "13-a-responses-producer.test.ts": `import { createServer } from "node:http";
import { expect, it } from "vitest";
import { prepareSystemAgentRunAdmission } from ${source("agents/admitted-run-context.ts")};
import { runEmbeddedAgent } from ${source("agents/embedded-agent-runner/run.ts")};
import { getActiveNativeAttempt, getEmbeddedRunAttachment } from ${source("agents/embedded-agent-runner/run-state.ts")};
import { SessionManager } from ${source("agents/sessions/session-manager.ts")};
import { setRuntimeConfigSnapshot } from ${source("config/runtime-snapshot.ts")};

const probeKey = Symbol.for(${JSON.stringify(NON_ISOLATED_RESPONSES_PROBE_KEY)});

it("leaves a real Responses producer for file teardown", async () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const probe = {
    connectionClosed: false,
    runSettled: false,
    generationCleanupSettled: false,
    generationCleanupFailure: undefined as string | undefined,
    providerStarted: false,
    runFailure: undefined as string | undefined,
  };
  let producerResponse: import("node:http").ServerResponse | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // The real transport must finish sending the request before the held stream starts.
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      producerResponse = response;
      response.write(
        "data: " + JSON.stringify({
          type: "response.created",
          response: {
            id: "resp_non_isolated_teardown",
            object: "response",
            status: "in_progress",
            output: [],
          },
        }) + "\\n\\n",
      );
      response.on("close", () => {
        probe.connectionClosed = true;
      });
      probe.providerStarted = true;
      resolveStarted();
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Responses teardown fixture did not bind a TCP port");
  }
  const modelId = "held-responses";
  const config = {
    plugins: { enabled: false },
    agents: {
      entries: { main: { workspace: import.meta.dirname } },
      defaults: {
        workspace: import.meta.dirname,
        skipBootstrap: true,
        model: { primary: "fixture/" + modelId },
        models: { ["fixture/" + modelId]: { agentRuntime: { id: "openclaw" } } },
      },
    },
    tools: { profile: "minimal", codeMode: false, toolSearch: false },
    models: {
      mode: "replace",
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          apiKey: "synthetic-responses-key",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [{
            id: modelId,
            name: "Held Responses",
            api: "openai-responses",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 256,
          }],
        },
      },
    },
  } as const;
  setRuntimeConfigSnapshot(config);
  const sessionId = "non-isolated-responses";
  const runId = "non-isolated-responses-run";
  const abortController = new AbortController();
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "non-isolated-runner");
  const runDone = runEmbeddedAgent({
    preparedRunAdmission: admission,
    abortSignal: abortController.signal,
    agentId: "main",
    sessionId,
    sessionKey: "agent:main:" + sessionId,
    sessionManager: SessionManager.inMemory(import.meta.dirname),
    sessionPersistence: "detached",
    agentDir: import.meta.dirname,
    workspaceDir: import.meta.dirname,
    config,
    provider: "fixture",
    model: modelId,
    agentHarnessRuntimeOverride: "openclaw",
    modelSelectionLocked: true,
    codeModeOverride: false,
    thinkLevel: "off",
    toolsAllow: [],
    prompt: "Wait for cancellation.",
    timeoutMs: 60_000,
    runId,
  }).then(
    () => undefined,
    (error) => { probe.runFailure = String(error); },
  ).finally(() => {
    admission.close();
    probe.runSettled = true;
  });
  Object.assign(probe, {
    runDone,
    abort: () => abortController.abort(new Error("fixture fallback cleanup")),
    destroyProducer: () => producerResponse?.destroy(),
    closeServer: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  });
  (globalThis as Record<PropertyKey, unknown>)[probeKey] = probe;
  await Promise.race([
    started,
    runDone.then(() => {
      if (!probe.providerStarted) {
        throw new Error("Responses producer ended before the request arrived: " + probe.runFailure);
      }
    }),
  ]);
  // The held response keeps the native attempt attached until teardown cancels it.
  expect(probe.runSettled).toBe(false);
  const handle = getActiveNativeAttempt(sessionId);
  const cleanupSettlement = handle && getEmbeddedRunAttachment(handle)?.runCleanupSettlement;
  if (!cleanupSettlement) {
    throw new Error("Responses teardown fixture did not attach generation cleanup");
  }
  const cleanupSettled = cleanupSettlement.then(
    () => { probe.generationCleanupSettled = true; },
    (error) => { probe.generationCleanupFailure = String(error); },
  );
  Object.assign(probe, { cleanupSettled });
  expect(probe.connectionClosed).toBe(false);
});
`,
    "13-b-responses-observer.test.ts": `import { expect, it } from "vitest";

const probeKey = Symbol.for(${JSON.stringify(NON_ISOLATED_RESPONSES_PROBE_KEY)});
const state = globalThis as Record<PropertyKey, any>;
const probe = state[probeKey];
// Capture at module evaluation so late cleanup during this test cannot satisfy it.
const cleanupAtImport = probe && {
  connectionClosed: probe.connectionClosed,
  runSettled: probe.runSettled,
  generationCleanupSettled: probe.generationCleanupSettled,
  generationCleanupFailure: probe.generationCleanupFailure,
};

it("settles the producer before the next file loads", async () => {
  if (!probe) throw new Error("missing Responses teardown probe");
  try {
    expect(cleanupAtImport).toEqual({
      connectionClosed: true,
      runSettled: true,
      generationCleanupSettled: true,
      generationCleanupFailure: undefined,
    });
  } finally {
    if (!probe.runSettled) {
      probe.abort();
      probe.destroyProducer();
    }
    await probe.runDone;
    await probe.cleanupSettled;
    await probe.closeServer();
    delete state[probeKey];
  }
});
`,
    "13-c-file-owned-logger.test.ts": `import { expect, it, vi } from "vitest";

vi.mock(${source("logging/subsystem.ts")}, () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

it("tears down run state without expanding imports through file-owned mocks", () => {
  expect(globalThis[Symbol.for("openclaw.embeddedRunsTestApi")]).toBeDefined();
});
`,
    "13-d-file-owned-paths.test.ts": `import { expect, it, vi } from "vitest";

vi.mock(${source("config/paths.ts")}, () => ({
  resolveStateDir: () => "/synthetic/state",
}));

it("tears down run state without evaluating through a file-owned paths mock", () => {
  expect(globalThis[Symbol.for("openclaw.embeddedRunsTestApi")]).toBeDefined();
});
`,
    "13-e-module-mock.test.ts": `import { expect, it, vi } from "vitest";
import { SessionStoreRegistryReadRequired } from ${source("config/sessions/session-sqlite-target.ts")};
import { readSessionStoreTargetInventory } from ${source("config/sessions/session-store-target-inventory.ts")};
import { resolveExistingAgentSessionStoreTargetsReadOnlyResult } from ${source("config/sessions/targets-read-availability.worker.ts")};

vi.mock(${source("config/sessions/targets-read-availability.worker.ts")}, () => ({
  resolveExistingAgentSessionStoreTargetsReadOnlyResult: vi.fn(),
}));

it("applies a later file's module mock after run teardown", () => {
  vi.mocked(resolveExistingAgentSessionStoreTargetsReadOnlyResult)
    .mockReturnValueOnce({ available: false, reason: "read-failed" })
    .mockImplementationOnce(() => { throw new SessionStoreRegistryReadRequired(); });
  expect(readSessionStoreTargetInventory({
    config: {},
    agentIds: ["main", "other"],
    env: {},
    paths: new Map(),
    candidates: [],
    registeredDatabases: { status: "deferred" },
  })).toEqual({ kind: "session-target-registry-required", readFailed: true });
});
`,
  };
}
