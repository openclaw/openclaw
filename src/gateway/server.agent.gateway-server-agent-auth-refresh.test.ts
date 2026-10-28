import { afterEach, expect, test, vi } from "vitest";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { runtimeAuthProfileRowsCache } from "../agents/auth-profiles/runtime-persisted-rows.js";
import { setRuntimeAuthProfileStoreSnapshot } from "../agents/auth-profiles/runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../agents/prepared-model-runtime-generation-scope.js";
import {
  beginPreparedModelRuntimePluginDrain,
  loadPublishedGatewayReplyDispatchRuntime,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { createSqliteReadOnlyWorkerScope } from "../infra/sqlite-readonly-worker-context.js";
import {
  getActiveGatewayRootWorkCount,
  getActiveGatewayRootWorkHolders,
} from "../process/gateway-work-admission.js";
import {
  activateSecretsRuntimeSnapshot,
  clearSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { installConnectedSessionStoreGatewaySuite } from "./test-helpers.connected-session-store.js";
import {
  agentCommandMock,
  agentDiscoveryMock,
  installGatewayTestHooks,
  onceMessage,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const gatewaySuite = installConnectedSessionStoreGatewaySuite("openclaw-gw-auth-refresh-", {
  client: { id: "gateway-client", version: "1.0.0", platform: "test", mode: "backend" },
});

type AgentRpcFrame = Omit<ResponseFrame, "payload"> & { payload?: { status?: string } };

const rpcDrains: Array<Promise<PromiseSettledResult<AgentRpcFrame>[]>> = [];

function sendAgentRpc(agentId: string, runId: string) {
  const socket = gatewaySuite.ws;
  let responseReceived = false;
  const response = onceMessage<AgentRpcFrame>(socket, (frame) => {
    if (frame.type !== "res" || frame.id !== runId) {
      return false;
    }
    responseReceived = true;
    return true;
  });
  const final = onceMessage<AgentRpcFrame>(
    socket,
    (frame) => frame.type === "res" && frame.id === runId && frame.payload?.status !== "accepted",
  );
  // Observe both listeners immediately, then drain them before the shared server resets.
  rpcDrains.push(Promise.allSettled([response, final]));
  socket.send(
    JSON.stringify({
      type: "req",
      id: runId,
      method: "agent",
      params: { agentId, message: `dispatch ${runId}`, idempotencyKey: runId },
    }),
  );
  return { response, final, hasResponse: () => responseReceived };
}

function refreshAuth(agentDir: string, key: string) {
  setRuntimeAuthProfileStoreSnapshot(
    {
      version: 1,
      profiles: { "anthropic:default": { type: "api_key", provider: "anthropic", key } },
    },
    agentDir,
  );
}

function observePublication(phase: "published" | "failed") {
  const settled = createDeferred();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === phase) {
      settled.resolve();
    }
  });
  return { promise: settled.promise, unregister, [Symbol.dispose]: unregister };
}

async function expectStatus(response: Promise<AgentRpcFrame>, status: string) {
  await expect(response).resolves.toMatchObject({ ok: true, payload: { status } });
}

async function expectCompleted(rpc: ReturnType<typeof sendAgentRpc>) {
  await expectStatus(rpc.response, "accepted");
  await expectStatus(rpc.final, "ok");
}

async function mockPublication(agentDir: string, result: () => Promise<void>) {
  const models = await import("../agents/models-config.js");
  const ensure = models.ensureOpenClawModelsJson;
  return vi
    .spyOn(models, "ensureOpenClawModelsJson")
    .mockImplementation(async (config, dir, options) => {
      if (dir !== agentDir) {
        return await ensure(config, dir, options);
      }
      await result();
      return {};
    });
}

function expectRuntime(
  runId: string,
  runtime: Awaited<ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime>>,
) {
  expect(agentCommandCallsFor(runId)[0]?.[4]).toMatchObject({
    config: runtime?.config,
    pluginGeneration: runtime?.pluginGeneration,
  });
}

function expectUnavailable(response: unknown, message: string) {
  expect(response).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: expect.stringContaining(message) },
  });
}

function agentCommandCallsFor(runId: string) {
  return vi
    .mocked(agentCommandMock)
    .mock.calls.filter(([options]) => (options as { runId?: string }).runId === runId);
}

async function prepareAuthDispatchAgents(affectedAgentId: string) {
  testState.agentsConfig = { entries: { main: {}, [affectedAgentId]: {} } };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "claude-opus-4-6", provider: "anthropic", input: ["text"] }];
  const { clearConfigCache, clearRuntimeConfigSnapshot, getRuntimeConfig } =
    await import("../config/io.js");
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  await prepareGatewayReplyRuntimeForTest({ force: true });
  const config = getRuntimeConfig();
  return {
    agentDir: resolveAgentDir(config, affectedAgentId),
    runtime: await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
  };
}

afterEach(async () => {
  const outcomes = await Promise.all(rpcDrains.splice(0));
  testState.agentsConfig = undefined;
  expect(outcomes.flat().every((outcome) => outcome.status === "fulfilled")).toBe(true);
});

test("keeps queued auth publication readable after startup readers close", async () => {
  const agentId = "auth-startup";
  const before = await prepareAuthDispatchAgents(agentId);
  // A persisted store makes publication read the real SQLite catalog.
  saveAuthProfileStore({ version: 1, profiles: {} }, before.agentDir);
  await prepareGatewayReplyRuntimeForTest({ force: true });
  const readers = createSqliteReadOnlyWorkerScope();
  const drain = beginPreparedModelRuntimePluginDrain();
  const settled = createDeferred<{ phase: string; error?: unknown }>();
  const unregister = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "published" || event.phase === "failed") {
      settled.resolve(event);
    }
  });
  try {
    readers.run(() => refreshAuth(before.agentDir, "synthetic-startup-key"));
    // Recovery can leave no resident rows; publication must also work on a cold read.
    runtimeAuthProfileRowsCache.invalidateRows(resolveAuthProfileDatabasePath(before.agentDir));
    await readers.close();
    // Recovery ends before the independently queued publication can run.
    drain.release();
    expect(await settled.promise).toEqual({ phase: "published" });
    expect(await rpcReq(gatewaySuite.ws, "models.list", { agentId })).toMatchObject({ ok: true });
    expect(await rpcReq(gatewaySuite.ws, "sessions.list", {})).toMatchObject({ ok: true });
    const runId = "idem-agent-auth-startup";
    await expectCompleted(sendAgentRpc(agentId, runId));
    expect(agentCommandCallsFor(runId)).toHaveLength(1);
  } finally {
    unregister();
    drain.release();
    await readers.close();
  }
});

test("keeps an accepted run on its admitted runtime generation", async () => {
  const affectedAgentId = "auth-pinned";
  const admittedRunId = "idem-agent-auth-admitted";
  const subsequentRunId = "idem-agent-auth-next";
  const before = await prepareAuthDispatchAgents(affectedAgentId);
  expect(before.runtime).toBeDefined();
  const preparedRuntime = await import("../agents/prepared-model-runtime.js");
  const acquireRuntime = preparedRuntime.acquireAgentRunPreparedModelRuntime;
  const admittedSnapshots: Array<Awaited<ReturnType<typeof acquireRuntime>>["snapshot"]> = [];
  // Admission can derive a selected snapshot from the configured generation. Capture
  // the actual lease before ACK, then prove refresh cannot replace that run's identity.
  using acquireSpy = vi.spyOn(preparedRuntime, "acquireAgentRunPreparedModelRuntime");
  acquireSpy.mockImplementation(async (input, options) => {
    const lease = await acquireRuntime(input, options);
    if (input.agentId === affectedAgentId) {
      admittedSnapshots.push(lease.snapshot);
    }
    return lease;
  });
  const dispatchedSnapshots = new Map<string, (typeof admittedSnapshots)[number] | undefined>();
  const originalCommand = agentCommandMock.getMockImplementation();
  expect(originalCommand).toBeDefined();
  const dispatchEntered = createDeferred();
  const releaseDispatch = createDeferred();
  const handlerHelpers = await import("./agent-turn/agent-handler-helpers.js");
  // Receiving the ACK is not a barrier against the server's dispatch timer.
  using yieldSpy = vi.spyOn(handlerHelpers, "yieldAfterAgentAcceptedAck");
  yieldSpy.mockImplementationOnce(() => {
    dispatchEntered.resolve();
    return releaseDispatch.promise;
  });
  using published = observePublication("published");
  try {
    agentCommandMock.mockImplementation((options, ...args) => {
      if (
        !options ||
        typeof options !== "object" ||
        !("runId" in options) ||
        typeof options.runId !== "string"
      ) {
        throw new Error("Expected an agent command with a run ID");
      }
      const generation = getPreparedModelRuntimePluginGeneration();
      dispatchedSnapshots.set(
        options.runId,
        generation ? getPreparedModelRuntimeBorrowedSnapshot(generation) : undefined,
      );
      return originalCommand!(options, ...args);
    });
    const admitted = sendAgentRpc(affectedAgentId, admittedRunId);
    await expectStatus(admitted.response, "accepted");
    await expect(Promise.race([dispatchEntered.promise, admitted.final])).resolves.toBeUndefined();
    expect(agentCommandCallsFor(admittedRunId)).toHaveLength(0);
    expect(admittedSnapshots.length).toBe(1);
    const admittedSnapshot = admittedSnapshots[0];
    expect(admittedSnapshot).toBeDefined();

    refreshAuth(before.agentDir, "next-generation-key");
    await expect(Promise.race([published.promise, admitted.final])).resolves.toBeUndefined();
    const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId });
    expect(after).not.toBe(before.runtime);
    expect(agentCommandCallsFor(admittedRunId)).toHaveLength(0);
    releaseDispatch.resolve();

    await expectStatus(admitted.final, "ok");
    expectRuntime(admittedRunId, before.runtime);
    expect(dispatchedSnapshots.get(admittedRunId) === admittedSnapshot).toBe(true);

    const subsequent = sendAgentRpc(affectedAgentId, subsequentRunId);
    await expectCompleted(subsequent);
    expectRuntime(subsequentRunId, after);
    expect(admittedSnapshots.length).toBe(2);
    // Auth refresh may reuse metadata and plugin identities, but the next lease is new.
    expect(admittedSnapshots[1] === admittedSnapshot).toBe(false);
    expect(dispatchedSnapshots.get(subsequentRunId) === admittedSnapshots[1]).toBe(true);
  } finally {
    releaseDispatch.resolve();
    agentCommandMock.mockImplementation(originalCommand!);
  }
});

test("aborts one affected waiter without cancelling shared auth publication", async () => {
  const affectedAgentId = "auth-wait";
  const abortedRunId = "idem-agent-auth-aborted";
  const waitingRunId = "idem-agent-auth-waiting";
  const siblingRunId = "idem-agent-auth-sibling";
  const subsequentRunId = "idem-agent-auth-subsequent";
  const before = await prepareAuthDispatchAgents(affectedAgentId);
  const activeWorkBefore = getActiveGatewayRootWorkCount();
  const runExecution = await observeGatewayRunExecution();
  const preparedRuntime = await import("../agents/prepared-model-runtime.js");
  const loadRuntime = preparedRuntime.loadPublishedGatewayReplyDispatchRuntime;
  const waitersEntered = createDeferred();
  let waiterCount = 0;
  const runtimeSpy = vi
    .spyOn(preparedRuntime, "loadPublishedGatewayReplyDispatchRuntime")
    .mockImplementation((params) => {
      const pending = loadRuntime(params);
      if (params.agentId === affectedAgentId && params.abortSignal && ++waiterCount === 2) {
        waitersEntered.resolve();
      }
      return pending;
    });
  const publicationGate = createDeferred();
  const ensureSpy = await mockPublication(before.agentDir, () => publicationGate.promise);
  const published = observePublication("published");
  let participantRecorded = false;
  const unsubscribeParticipant = onSessionLifecycleEvent((event) => {
    if (
      event.reason === "participants" &&
      event.agentId === "main" &&
      event.sessionKey === "agent:main:main"
    ) {
      participantRecorded = true;
    }
  });
  try {
    refreshAuth(before.agentDir, "fresh-generation-key");
    const sibling = sendAgentRpc("main", siblingRunId);
    await expectCompleted(sibling);
    await runExecution.waitForCompletion(siblingRunId);
    expect(participantRecorded).toBe(true);
    expect(agentCommandCallsFor(siblingRunId)).toHaveLength(1);
    const aborted = sendAgentRpc(affectedAgentId, abortedRunId);
    const waiting = sendAgentRpc(affectedAgentId, waitingRunId);
    await expect(
      Promise.race([waitersEntered.promise, aborted.response, waiting.response]),
    ).resolves.toBeUndefined();
    expect(agentCommandCallsFor(abortedRunId)).toHaveLength(0);
    expect(agentCommandCallsFor(waitingRunId)).toHaveLength(0);
    expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(
      activeWorkBefore + 2,
    );

    const abort = await rpcReq(gatewaySuite.ws, "chat.abort", {
      sessionKey: `agent:${affectedAgentId}:main`,
      runId: abortedRunId,
    });
    expect(abort).toMatchObject({ ok: true, payload: { aborted: true, runIds: [abortedRunId] } });
    await expect(aborted.response).resolves.toMatchObject({
      ok: true,
      payload: {
        status: "timeout",
        stopReason: "rpc",
        timeoutPhase: "queue",
        providerStarted: false,
      },
    });
    await runExecution.waitForCompletion(abortedRunId);
    expect(getActiveGatewayRootWorkCount(), getActiveGatewayRootWorkHolders().join(", ")).toBe(
      activeWorkBefore + 1,
    );
    expect(waiting.hasResponse()).toBe(false);

    publicationGate.resolve();
    await published.promise;
    const after = await loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId });
    expect(after).not.toBe(before.runtime);
    await expectCompleted(waiting);
    expect(agentCommandCallsFor(waitingRunId)).toHaveLength(1);
    expectRuntime(waitingRunId, after);
    const subsequent = sendAgentRpc(affectedAgentId, subsequentRunId);
    await expectCompleted(subsequent);
    expect(agentCommandCallsFor(subsequentRunId)).toHaveLength(1);
  } finally {
    publicationGate.resolve();
    published.unregister();
    ensureSpy.mockRestore();
    try {
      await runExecution.restore();
    } finally {
      runtimeSpy.mockRestore();
      unsubscribeParticipant();
    }
  }
});

test("never reuses an affected projection after auth publication rejects", async () => {
  const affectedAgentId = "auth-reject";
  const runId = "idem-agent-auth-reject";
  const before = await prepareAuthDispatchAgents(affectedAgentId);
  using ensureSpy = await mockPublication(before.agentDir, async () => {
    throw new Error("auth publication rejected");
  });
  using failed = observePublication("failed");
  refreshAuth(before.agentDir, "rejected-generation-key");
  await failed.promise;
  const unavailable = `prepared reply dispatch runtime owner was not published for ${affectedAgentId}`;
  await expect(
    loadPublishedGatewayReplyDispatchRuntime({ agentId: affectedAgentId }),
  ).rejects.toThrow(unavailable);

  const rejected = sendAgentRpc(affectedAgentId, runId);
  expectUnavailable(await rejected.response, unavailable);
  expect(agentCommandCallsFor(runId)).toHaveLength(0);
  ensureSpy.mockRestore();
});

test("reports provider auth refresh failures over the connected Gateway", async () => {
  let authStoreReads = 0;
  const prepared = await prepareSecretsRuntimeSnapshot({
    config: {},
    agentDirs: [resolveAgentDir({}, "main")],
    includeConfigRefs: false,
    manifestRegistry: { plugins: [] },
    loadAuthStore: () => {
      authStoreReads += 1;
      if (authStoreReads > 1) {
        throw new Error("simulated provider auth refresh failure");
      }
      return { version: 1, profiles: {} };
    },
  });
  using secrets = { prepared, [Symbol.dispose]: clearSecretsRuntimeSnapshot };
  activateSecretsRuntimeSnapshot(secrets.prepared);
  const response = await rpcReq(gatewaySuite.ws, "models.authStatus", { refresh: true });

  expect(authStoreReads).toBe(2);
  expectUnavailable(response, "simulated provider auth refresh failure");
});
