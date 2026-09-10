import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  createReplyOperation,
  type ReplyBackendQueueMessageOptions,
} from "../../auto-reply/reply/reply-run-registry.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { listSessionPendingInputReceipts } from "../../config/sessions/session-accessor.pending-inputs.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { registerSupervisedTaskAdmissionOwner } from "../../tasks/supervised-task.admission-owner.js";
import { heartbeatTaskSupervisor, listSupervisedTasks } from "../../tasks/supervised-task.store.js";
import { maybeAdmitSupervisedGatewayRoot } from "../agent-turn/agent-run-supervised-root.js";
import { registerChatAbortController } from "../chat-abort.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { handleChatSend } from "./chat-send-handler.js";
import type { GatewayClient, RespondFn } from "./types.js";

const classifier = vi.hoisted(() => vi.fn());
vi.mock("../../agents/isolated-completion.js", () => ({ runIsolatedCompletion: classifier }));
vi.mock("../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "codex", runtimeSource: "provider" }),
}));
installGatewayTestHooks();
const dirs = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => void> = [];
beforeEach(() => {
  classifier
    .mockReset()
    .mockResolvedValue({ text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function fixture(active = true, collectInput = false) {
  const dir = dirs.make("supervised-chat-");
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  const policyFile = path.join(dir, "policy.json");
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      version: 1,
      scope: "Repair a fixture",
      goal: {
        objective: "Repair fixture",
        success: [{ id: "correct", description: "Reviewed artifact" }],
        partial: [],
      },
      workflow: {
        version: 1,
        workspace,
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      },
      maxAttempts: 4,
      attemptTimeoutMs: 10_000,
      episodeTimeoutMs: 60_000,
    }),
    { mode: 0o600 },
  );
  testState.agentsConfig = {
    entries: { main: { taskSupervision: { enabled: true, policyFile } } },
  };
  testState.agentConfig = { model: { primary: "openai/supervision-fixture-model" } };
  const storePath = path.join(dir, "sessions.json");
  testState.sessionStorePath = storePath;
  const scope = {
    agentId: "main",
    sessionKey: "agent:main:main",
    sessionId: "chat-source",
    storePath,
  };
  await writeSessionStore({
    entries: {
      main: {
        sessionId: scope.sessionId,
        updatedAt: Date.now(),
        status: active ? "running" : "done",
      },
    },
  });
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "Keep working on the current request.", timestamp: 1 },
  });
  const queueMessage = vi.fn(async (_text: string, options?: ReplyBackendQueueMessageOptions) => {
    const recorder = options?.userTurnTranscriptRecorder;
    if (collectInput && recorder) {
      const aggregate = createUserTurnTranscriptRecorder({
        input: { text: "Collected follow-up", idempotencyKey: "collected-input:user" },
        pendingInputSources: [recorder],
        target: {
          ...scope,
          sessionEntry: loadSessionEntry(scope),
          expectedSessionId: scope.sessionId,
        },
      });
      await aggregate.persistApproved();
    } else {
      await recorder?.persistApproved();
    }
  });
  if (active) {
    const operation = createReplyOperation({ ...scope, resetTriggered: false });
    operation.setPhase("running");
    // The simulated backend has matching prepared tool authority. This test
    // exercises real ingress ordering/custody, not the fingerprint algorithm.
    operation.bindToolAuthoritySnapshot({
      fingerprint: () => "fixture-authority",
      project: () => "fixture-authority",
    });
    operation.bindToolAuthorityRoute({ provider: "openai", model: "supervision-fixture-model" });
    operation.attachBackend({
      kind: "embedded",
      runId: "existing-model-run",
      cancel: vi.fn(),
      messageInjection: { isAvailable: () => true, queueMessage },
    });
    cleanups.push(() => operation.complete());
  }
  cleanups.push(
    registerSupervisedTaskAdmissionOwner(async () => {
      heartbeatTaskSupervisor("test-supervisor", Date.now(), 10_000);
      return "test-supervisor";
    }),
  );
  dispatchInboundMessageMock.mockResolvedValue({});
  const context = createDirectChatContext({ getRuntimeConfig, chatQueuedTurns: new Map() });
  const client: GatewayClient = {
    connId: "supervised-browser",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
    },
  };
  const params = {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    message: "Repair the fixture",
    idempotencyKey: "supervised-chat-input",
    queueMode: "steer" as const,
  };
  const send = async (respond = vi.fn<RespondFn>(), external = true) => {
    await (external ? handleDirectExternalChatSend : handleChatSend)({
      params,
      req: { type: "req", id: "request", method: "chat.send", params },
      context,
      client,
      respond,
      isWebchatConnect: () => true,
    });
  };
  return { scope, queueMessage, send, context, client, params };
}

it("admits before ACK or active backend injection and replays the same task after a lost response", async () => {
  const f = await fixture();
  const release = createDeferred();
  classifier.mockImplementation(async () => {
    await release.promise;
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  const respond = vi.fn<RespondFn>();
  const sent = f.send(respond);
  try {
    await vi.waitFor(() =>
      expect(classifier, JSON.stringify(respond.mock.calls)).toHaveBeenCalledOnce(),
    );
    expect(respond).not.toHaveBeenCalled();
    expect(f.queueMessage).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await sent;
  }
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      status: "ok",
      supervisedTask: expect.objectContaining({ episode: 1 }),
    }),
    undefined,
    expect.anything(),
  );
  const tasks = listSupervisedTasks();
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  assert.isDefined(task);
  expect(task).toMatchObject({ phase: "ready", attempts: 0 });
  expect(listSessionPendingInputs(f.scope).total).toBe(0);
  f.context.dedupe.clear();
  const replay = vi.fn<RespondFn>();
  await f.send(replay);
  expect(replay).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      status: "ok",
      supervisedTask: { flowId: task.flowId, episode: task.episode },
    }),
    undefined,
    expect.anything(),
  );
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toEqual(tasks);
  expect(f.queueMessage).not.toHaveBeenCalled();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

it("does not admit after the exact source session rotates during classification", async () => {
  const f = await fixture(false);
  classifier.mockImplementation(async () => {
    await patchSessionEntryCore(f.scope, () => ({ sessionId: "replacement-session" }));
    return { text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } };
  });
  const respond = vi.fn<RespondFn>();
  await f.send(respond);
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  expect(respond.mock.calls.some(([ok]) => !ok)).toBe(true);
  expect(loadSessionEntry(f.scope)?.sessionId).toBe("replacement-session");
});

it("keeps internal re-entry out of automatic admission", async () => {
  const f = await fixture();
  await f.send(vi.fn<RespondFn>(), false);
  expect(classifier).not.toHaveBeenCalled();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(f.queueMessage).toHaveBeenCalledOnce();
});

it("preserves ordinary active-run injection when the classifier selects conversation", async () => {
  const f = await fixture();
  classifier.mockResolvedValue({
    text: '{"kind":"ordinary"}',
    owner: { kind: "harness", id: "codex" },
  });
  await f.send();
  expect(classifier).toHaveBeenCalledOnce();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(f.queueMessage).toHaveBeenCalledOnce();
});

it("replays consumed collected input after supervision is enabled without classifying it", async () => {
  const f = await fixture(true, true);
  const enabledConfig = getRuntimeConfig();
  const enabledPolicy = enabledConfig.agents?.entries?.main?.taskSupervision;
  assert.isDefined(enabledPolicy);
  setRuntimeConfigSnapshot({
    ...enabledConfig,
    agents: {
      ...enabledConfig.agents,
      entries: {
        ...enabledConfig.agents?.entries,
        main: {
          ...enabledConfig.agents?.entries?.main,
          taskSupervision: { ...enabledPolicy, enabled: false },
        },
      },
    },
  });
  const first = vi.fn<RespondFn>();
  await f.send(first);
  expect(f.queueMessage, JSON.stringify(first.mock.calls)).toHaveBeenCalledOnce();
  expect(classifier).not.toHaveBeenCalled();
  expect(f.queueMessage.mock.calls[0]?.[1]?.userTurnTranscriptRecorder).toBeDefined();
  await f.queueMessage.mock.results[0]?.value;
  expect(
    f.queueMessage.mock.calls[0]?.[1]?.userTurnTranscriptRecorder?.getPendingInputMessage?.(),
  ).toBeDefined();
  expect(listSessionPendingInputReceipts(f.scope, { runIds: [f.params.idempotencyKey] })).toEqual([
    { runId: f.params.idempotencyKey, state: "consumed", consumedByEventId: expect.any(String) },
  ]);
  expect(listSessionPendingInputs(f.scope).total).toBe(0);
  setRuntimeConfigSnapshot(enabledConfig);
  // A Gateway restart loses transient admission/ACK state, not consumed custody.
  f.context.dedupe.clear();
  f.context.chatAbortControllers.clear();
  f.context.chatQueuedTurns?.clear();
  const replay = vi.fn<RespondFn>();
  await f.send(replay);
  expect(replay).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ runId: f.params.idempotencyKey, status: "ok" }),
    undefined,
    expect.objectContaining({ cached: true }),
  );
  expect(classifier).not.toHaveBeenCalled();
  expect(listSupervisedTasks()).toHaveLength(0);
  expect(f.queueMessage).toHaveBeenCalledOnce();
  expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
});

it.each(["throws", "missing-anchor"] as const)(
  "does not commit an agent-root task when source transcript persistence %s",
  async (failure) => {
    const f = await fixture(false);
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: f.params.message },
      target: { ...f.scope, sessionEntry: loadSessionEntry(f.scope) },
    });
    const persist = vi.spyOn(recorder, "persistApproved");
    if (failure === "throws") {
      persist.mockRejectedValue(new Error("source transcript unavailable"));
    } else {
      persist.mockResolvedValue(undefined);
    }
    const activeRunAbort = registerChatAbortController({
      ...f.scope,
      chatAbortControllers: f.context.chatAbortControllers,
      runId: f.params.idempotencyKey,
      timeoutMs: 60_000,
    });
    cleanups.push(activeRunAbort.cleanup);
    const onRejected = vi.fn();
    const emitAcceptance = vi.fn();
    await maybeAdmitSupervisedGatewayRoot({
      admission: {
        cfg: getRuntimeConfig(),
        activeSessionAgentId: f.scope.agentId,
        resolvedSessionKey: f.scope.sessionKey,
        suppressVisibleSessionEffects: false,
        isOneShotModelRun: false,
        isRestartRecoveryResumeRun: false,
        canUseInternalRuntimeHandoff: false,
        sessionEntry: loadSessionEntry(f.scope),
        images: [],
        offloadedRefs: [],
        assertGatewayWorkAdmissionAllowed: () => {},
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        getAdmittedSessionId: () => f.scope.sessionId,
        runId: f.params.idempotencyKey,
        markAgentRunAccepted: vi.fn(),
        context: f.context,
        agentDedupeKeys: [`agent:${f.params.idempotencyKey}`],
        io: { emitAcceptance, emitFinal: vi.fn() },
      },
      userTurn: {
        execApprovalFollowupHandoffClaimId: "no-followup",
        message: f.params.message,
        recorder,
        senderIsOwner: true,
        suppressPromptPersistence: false,
      },
      activeModel: { provider: "openai", model: "supervision-fixture-model" },
      activeRunAbort,
      onInputAccepted: vi.fn(),
      onAccepted: vi.fn(),
      onRejected,
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(listSupervisedTasks()).toHaveLength(0);
    expect(onRejected).toHaveBeenCalledOnce();
    expect(emitAcceptance).not.toHaveBeenCalled();
  },
);
