import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../agents/internal-runtime-context.js";
import {
  runSessionManagerWrite,
  withSessionManagerWriteAssertion,
} from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { recordSubagentFailureHandoff } from "../../agents/subagents/registry/subagent-failure-handoff.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  createSubagentStoreRunFixture,
  persistRegistryFixture,
  loadSubagentRegistryFromSqlite,
} from "../../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../../agents/subagents/registry/subagent-registry-state.js";
import { buildRequesterSettleWakeIdentity } from "../../agents/subagents/registry/subagent-requester-settle-identity.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputs from "../../config/sessions/session-accessor.pending-inputs.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileDisplayName,
} from "../../state/user-profile-writes.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { withSessionSendDelivery } from "../session-send-delivery.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createAgentTurnTestContext } from "./agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  reconcileAgentRunUserTurnCompletion as reconcileCompletion,
  releasePreparedAgentRunUserTurn as release,
} from "./agent-run-user-turn.js";
import { createTestRpcSource, testRpcSourceController } from "./rpc-source.test-support.js";

const reads = vi.hoisted(() => ({ command: vi.fn() }));
// mock-isolation: Keep model/tools outside this regression; the Gateway terminal dispatcher stays native.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: reads.command }));

type TurnParams = Parameters<typeof prepareAgentRunUserTurn>[0];
type Recorder = NonNullable<Awaited<ReturnType<typeof prepareAgentRunUserTurn>>["recorder"]>;
function makeTurnParams(
  target: { sessionKey: string; sessionId: string; storePath: string },
  message: string,
  runId: string,
  overrides: Partial<Omit<TurnParams, "request">> & {
    request?: Partial<TurnParams["request"]>;
  } = {},
): TurnParams {
  return {
    assertCurrent: () => {},
    onUserTurnMediaPersisted: () => {},
    cfg: { session: { store: target.storePath } },
    resolvedSessionKey: target.sessionKey,
    admittedSessionId: target.sessionId,
    activeSessionAgentId: "main",
    suppressVisibleSessionEffects: false,
    requestedPromptPersistenceSuppression: false,
    canUseInternalRuntimeHandoff: false,
    message,
    effectiveTranscriptInputText: message,
    images: [],
    offloadedRefs: [],
    runId,
    client: null,
    context: createAgentTurnTestContext(),
    ...overrides,
    request: { message, idempotencyKey: runId, ...overrides.request },
  };
}
async function withTurn<T>(params: TurnParams, body: (recorder: Recorder) => Promise<T>) {
  const turn = await prepareAgentRunUserTurn(params);
  try {
    return await body(expectDefined(turn.recorder, "prepared recorder"));
  } finally {
    await release(turn);
  }
}

let state: OpenClawTestState;
beforeEach(async () => {
  // The Gateway recorder and native writers must share one explicit fixture root,
  // including when the test runner inherited a named operator profile.
  state = await createOpenClawTestState({ prefix: "settle-continuation-native-" });
});
afterEach(async () => {
  await state.cleanup();
  subagentRuns.clear();
  clearSubagentRunsReadCacheForTest();
});
const fixture = {
  storePath: () => path.join(state.sessionsDir(), "sessions.json"),
  sessionsDir: () => state.sessionsDir(),
};
async function expectUserInputs(scope: Parameters<typeof loadTranscriptEvents>[0], count: number) {
  const users = (await loadTranscriptEvents(scope)).filter(
    (entry) =>
      isIndexedSessionEntry(entry) && entry.type === "message" && entry.message.role === "user",
  );
  expect(users).toHaveLength(count);
}

describe("requester-settle processing survives later user turns", () => {
  const sessionKey = "agent:main:settle-continuation";
  const sessionId = "settle-continuation-session";
  const sourceSessionKey = "agent:main:subagent:completed-child";
  const runId = "announce:requester-settle:main:agent:main:settle-continuation:child:yield-1";
  const message = "Synthesize the completed child result";
  const request = { message, idempotencyKey: runId, deliver: false };
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const preparationContext = createAgentTurnTestContext();
  const logGateway = { ...preparationContext.logGateway, warn: vi.fn() };
  const prepare = (overrides: Partial<Parameters<typeof prepareAgentRunUserTurn>[0]> = {}) =>
    prepareAgentRunUserTurn(
      makeTurnParams(scope(), message, runId, {
        assertCompletionCurrent: () => {},
        settleWakeReplay: { sourceSessionKeys: [sourceSessionKey], assertCurrent: () => {} },
        getAbortStopReason: () => "rpc",
        sessionEntry: loadSessionEntry(scope()) ?? undefined,
        request,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey,
          sourceTool: "subagent_settle",
          sourceChannel: "internal",
        },
        context: { ...preparationContext, logGateway },
        ...overrides,
      }),
    );
  const assistant = (stopReason: "toolUse" | "stop", text = "") => ({
    ...makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 2, stopReason }),
    __openclaw: { runId },
  });
  const register = (instanceId: string) => {
    const entry = createTestRpcSource(
      { sessionKey, sessionId, operationalRunInstance: { runId, instanceId } },
      runId,
    );
    rpcSourceTesting.set(runId, entry);
    return entry;
  };
  const completedPayload = { status: "ok", summary: "completed", inputProcessingCompleted: true };
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  const dispatch = (turn: Prepared, entry: ReturnType<typeof createTestRpcSource>) => {
    const controller = testRpcSourceController(entry);
    const cleanupAbortController = vi.fn(() => {
      rpcSourceTesting.deleteExpected(runId, entry);
    });
    const emitFinal = vi.fn();
    const execute = () =>
      dispatchAgentRunFromGateway({
        admittedRunEntry: entry,
        ingressOpts: {
          message: turn.message,
          sessionKey,
          allowModelOverride: false,
          userTurnTranscriptRecorder: turn.recorder,
          abortSignal: controller.signal,
        },
        runId,
        dedupeKeys: [],
        abortController: controller,
        cleanupAbortController,
        io: { emitAcceptance: vi.fn(), emitFinal },
        context: createAgentTurnTestContext(),
      });
    return { entry, controller, cleanupAbortController, emitFinal, execute };
  };
  const completion = (turn: Prepared) => turn.recorder!.getProcessingCompletion!();
  const complete = (
    turn: Prepared,
    outcome: Parameters<typeof buildAgentRunTerminalOutcome>[0] = { status: "ok" },
  ) => completeUserTurnProcessing(turn.recorder, buildAgentRunTerminalOutcome(outcome));
  const reconciliation = (turn: Prepared) => {
    const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
    const cleanup = vi.fn(async () => {});
    return { io, cleanup, result: reconcileCompletion(turn, { runId }, cleanup, io) };
  };
  const expectAcknowledgement = async (turn: Prepared, payload: Record<string, unknown>) => {
    const { io, cleanup, result } = reconciliation(turn);
    await result;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(io.emitAcceptance).toHaveBeenCalledWith([true, { runId, ...payload }, undefined], {
      runId,
    });
  };
  const expectNoReconciliation = (turn: Prepared) => {
    expect(completion(turn)).toBeUndefined();
    const { io, cleanup, result } = reconciliation(turn);
    expect(result).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(io.emitAcceptance).not.toHaveBeenCalled();
  };
  const appendNewerTurn = async (manager: SessionManager, key: string, text: string) => {
    const user: PersistedUserTurnMessage = {
      role: "user",
      content: text,
      timestamp: 3,
      idempotencyKey: key,
    };
    await manager.appendMessageAsync(user);
    await manager.appendMessageAsync(assistant("stop", `${text} finished`));
  };
  const expectCompletedReplay = async (
    before: Awaited<ReturnType<typeof loadTranscriptEvents>>,
    prepareReplay = prepare,
    count = 1,
  ) => {
    rotateAgentEventLifecycleGeneration();
    for (let duplicate = 0; duplicate < count; duplicate++) {
      const replay = await prepareReplay();
      expect(completion(replay)).toMatchObject({ reason: "completed", status: "ok" });
      await expectAcknowledgement(replay, completedPayload);
      expect(await loadTranscriptEvents(scope())).toEqual(before);
      await release(replay);
    }
    expect(await loadTranscriptEvents(scope())).toEqual(before);
  };
  beforeEach(async () => {
    logGateway.warn.mockClear();
    reads.command.mockReset().mockResolvedValue({ payloads: [], meta: { yielded: true } });
    const entry = { sessionId, updatedAt: 1 };
    await upsertSessionEntryCore(scope(), entry);
  });

  it.each([false, true])(
    "reconciles prior private input but admits a fresh deliverable continuation (private=%s)",
    async (privateCompletion) => {
      const boundRequest = { ...request, expectedExistingSessionId: sessionId };
      const original = await prepare({
        privateCompletion: privateCompletion ? true : undefined,
        request: boundRequest,
      });
      await original.recorder!.persistApproved();
      await complete(original);
      await release(original);
      rotateAgentEventLifecycleGeneration();
      const retryRunId = buildRequesterSettleWakeIdentity({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        batchRunIds: ["child"],
        rearmGeneration: 1,
        hasPrivateCompletion: privateCompletion,
        retainedWake: { status: "pending", attemptCount: 1, nextAttemptAt: 30_000 },
      }).runId;
      expect(retryRunId).toBe(privateCompletion ? runId : `${runId}:retry-1`);
      const retryMessage = privateCompletion
        ? message
        : `${message}. Continue from the current transcript.`;
      const retry = await prepare({
        privateCompletion: privateCompletion ? true : undefined,
        runId: retryRunId,
        request: { ...boundRequest, idempotencyKey: retryRunId, message: retryMessage },
        message: retryMessage,
        effectiveTranscriptInputText: retryMessage,
      });
      if (privateCompletion) {
        await expectAcknowledgement(retry, completedPayload);
      } else {
        expectNoReconciliation(retry);
        expect(await retry.recorder!.persistApproved()).toMatchObject({ appended: true });
        await complete(retry);
      }
      await release(retry);
      await expectUserInputs(scope(), privateCompletion ? 1 : 2);
      expect(reads.command).not.toHaveBeenCalled();
    },
  );

  it("reconciles one completed yielded input after two newer finished turns without reopening it", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    await manager.appendMessageAsync(assistant("toolUse"));
    await manager.appendCustomMessageEntryAsync("openclaw.sessions_yield", "", false, { runId });
    const entry = register("settle-native-instance");
    const { emitFinal, execute } = dispatch(original, entry);
    await execute();
    expect(emitFinal).toHaveBeenCalledWith(
      [true, expect.objectContaining({ status: "ok", inputProcessingCompleted: true }), undefined],
      { runId },
    );
    const completed = completion(original);
    await release(original);
    for (const key of ["newer-one:user", "newer-two:user"]) {
      await appendNewerTurn(manager, key, "New user request");
    }
    const before = await loadTranscriptEvents(scope());
    await expect(
      manager.appendMessageAsync(original.recorder!.getPendingInputMessage!()!),
    ).rejects.toThrow("outside the current turn");
    expect(completed).toMatchObject({ reason: "completed", status: "ok" });
    await expectCompletedReplay(before, prepare, 2);
    expect(reads.command).toHaveBeenCalledOnce();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "durably cancels settlement (private=%s, consumed=%s) without acknowledging success",
    async (privateCompletion, consumed) => {
      const controller = new AbortController();
      const original = await prepare({
        abortSignal: controller.signal,
        privateCompletion: privateCompletion ? true : undefined,
        request: { ...request, expectedExistingSessionId: sessionId },
      });
      if (consumed) {
        await original.recorder!.persistApproved();
      }
      controller.abort();
      await original.recorder!.waitForPendingInputSettlement!();
      expect(completion(original)).toMatchObject({ reason: "cancelled", status: "error" });
      await release(original, "cancelled");
      rotateAgentEventLifecycleGeneration();
      const replay = await prepare();
      expect(completion(replay)).toMatchObject({ reason: "cancelled" });
      await expectAcknowledgement(replay, {
        status: "error",
        summary: "cancelled",
        stopReason: "rpc",
      });
      expect(reads.command).not.toHaveBeenCalled();
      await release(replay, "cancelled");
    },
  );

  it("cannot publish a cancellation after losing completion authority", async () => {
    let current = true;
    const controller = new AbortController();
    const original = await prepare({
      abortSignal: controller.signal,
      assertCompletionCurrent: () => {
        if (!current) {
          throw new Error("completion authority revoked");
        }
      },
    });
    await original.recorder!.persistApproved();
    const before = await loadTranscriptEvents(scope());
    current = false;
    controller.abort();
    await expect(original.recorder!.waitForPendingInputSettlement!()).rejects.toThrow(
      "completion authority revoked",
    );
    expect(logGateway.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("completion authority revoked"),
    );
    expect(completion(original)).toBeUndefined();
    await expect(complete(original)).rejects.toThrow("completion authority revoked");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await expect(release(original)).rejects.toThrow("completion authority revoked");
  });
  it.each([false, true])(
    "retains timeout input until its producer settles (classified=%s)",
    async (classified) => {
      const entry = register("settle-timeout-instance");
      const controller = testRpcSourceController(entry);
      const original = await prepare({
        abortSignal: controller.signal,
        getAbortStopReason: () => "timeout",
      });
      const { cleanupAbortController, emitFinal, execute } = dispatch(original, entry);
      await original.recorder!.persistApproved();
      const producerEntered = createDeferred();
      const finishProducer = createDeferred();
      reads.command.mockImplementationOnce(async () => {
        producerEntered.resolve();
        await finishProducer.promise;
        return {
          payloads: [],
          meta: {
            aborted: true,
            ...(classified ? { timeoutPhase: "provider", providerStarted: true } : {}),
          },
        };
      });
      const execution = withSessionTurn(
        { sessionKey, sessionId, target: entry.input.target, controllerInput: entry.input },
        execute,
      );
      try {
        await awaitGateBeforeSettlement(
          producerEntered.promise,
          execution,
          "Timeout continuation did not enter its producer",
        );
        controller.abort(new DOMException("Synthetic producer deadline", "TimeoutError"));
        await original.recorder!.waitForPendingInputSettlement!();
        expect(completion(original)).toBeUndefined();
        expect(cleanupAbortController).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        finishProducer.resolve();
        await execution;
        await original.recorder!.waitForPendingInputSettlement!();
        expect(completion(original)).toMatchObject({
          status: "timeout",
          reason: classified ? "hard_timeout" : "timed_out",
        });
        expect(cleanupAbortController).toHaveBeenCalledOnce();
      } finally {
        finishProducer.resolve();
        await execution;
        await release(original);
      }
      rotateAgentEventLifecycleGeneration();
      const replay = await prepare();
      // Timeouts remain nonfinal; they must not become a successful duplicate acknowledgement.
      expectNoReconciliation(replay);
      await release(replay);
    },
  );

  it("preserves live peer-delivery success and duplicate reconciliation", async () => {
    const delivery: Parameters<typeof withSessionSendDelivery>[0]["delivery"] = {
      version: 1,
      runId,
      source: { agentId: "main", sessionId: "peer-source", sessionKey: sourceSessionKey },
      target: { agentId: "main", sessionId, sessionKey },
      sandboxed: false,
      message: "Peer result",
    };
    const preparePeer = () =>
      withSessionSendDelivery({ delivery }, () =>
        prepare({
          settleWakeReplay: undefined,
          inputProvenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
        }),
      );
    const original = await preparePeer();
    await original.recorder!.persistApproved();
    expect(
      original.recorder!.getPendingInputMessage!()?.["__openclaw"]?.sessionSendDelivery,
    ).toBeUndefined();
    await complete(original);
    await release(original);
    const before = await loadTranscriptEvents(scope());
    await expectCompletedReplay(before, preparePeer);
    expect(reads.command).not.toHaveBeenCalled();
  });
});

it("keeps the committed child target and later owner metadata through input persistence", async () => {
  const sessionKey = "agent:main:subagent:fresh-child";
  const sessionId = "fresh-child-session";
  const sessionEntry = { sessionId, updatedAt: 1, label: "Created child" };
  const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
  await upsertSessionEntryCore(target, sessionEntry);
  await upsertSessionEntryCore(target, { ...sessionEntry, updatedAt: 2, label: "Renamed child" });
  const reroutedTarget = {
    ...target,
    sessionId: "unrelated-session",
    storePath: path.resolve(fixture.sessionsDir(), "../../../rerouted/sessions.json"),
  };
  await upsertSessionEntryCore(reroutedTarget, {
    sessionId: reroutedTarget.sessionId,
    updatedAt: 1,
  });
  const onInputCommitted = vi.fn();
  const params = makeTurnParams(target, "Child task", "fresh-child-run", {
    onInputCommitted,
    cfg: { session: { store: reroutedTarget.storePath } },
    sessionEntry,
    freshChildStorePath: target.storePath,
  });
  await withTurn(params, async (recorder) => {
    expect(recorder.getPendingInputMessage?.()).toMatchObject({ content: "Child task" });
    expect(await loadTranscriptEvents(target)).toEqual([]);
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    const messages = (await loadTranscriptEvents(target)).filter(
      (event) => isIndexedSessionEntry(event) && event.type === "message",
    );
    expect(messages).toMatchObject([{ message: { role: "user", content: "Child task" } }]);
    expect(onInputCommitted).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionKey, sessionId }),
    );
    expect(loadSessionEntry(target)).toMatchObject({ sessionId, label: "Renamed child" });
    expect(await loadTranscriptEvents(reroutedTarget)).toEqual([]);
  });
});

it.each([false, true])(
  "keeps healthy completion results runtime-only (private=%s)",
  async (privateCompletion) => {
    const target = {
      agentId: "main",
      sessionKey: "agent:main:healthy-completion",
      sessionId: "healthy-parent",
      storePath: fixture.storePath(),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const onInputCommitted = vi.fn();
    const params = makeTurnParams(
      target,
      "Continue the OpenClaw runtime event.",
      "announce:healthy-completion",
      {
        privateCompletion: privateCompletion ? true : undefined,
        onInputCommitted,
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:healthy",
          sourceTool: "subagent_announce",
        },
        request: {
          deliver: false,
          expectedExistingSessionId: target.sessionId,
          internalEvents: [
            {
              type: "task_completion",
              source: "subagent",
              childSessionKey: "agent:main:subagent:healthy",
              announceType: "completion",
              taskLabel: "healthy child",
              status: "ok",
              statusLabel: "completed",
              result: "HEALTHY_RUNTIME_ONLY",
              replyInstruction: "Review the result.",
            },
          ],
        },
      },
    );
    await withTurn(params, async (recorder) => {
      expect(await recorder.persistApproved()).toMatchObject({ appended: true });
      expect(onInputCommitted).toHaveBeenCalledOnce();
      expect(JSON.stringify(await loadTranscriptEvents(target))).not.toContain(
        "HEALTHY_RUNTIME_ONLY",
      );
      expect(params.request.internalEvents?.[0]?.result).toBe("HEALTHY_RUNTIME_ONLY");
    });
  },
);

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  "commits failure diagnostics with custody, not admission (private=%s, rejected=%s)",
  async (privateCompletion, rejected) => {
    const sessionKey = "agent:main:completion-handoff";
    const sessionId = "completion-handoff-session";
    const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const child = createSubagentStoreRunFixture({
      requesterSessionKey: sessionKey,
      requesterStorePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      completionRequesterSessionId: sessionId,
      completion: {
        required: true,
        resultText: "Saved partial progress: found the failing request.",
      },
      execution: {
        status: "terminal",
        endedAt: 8,
        outcome: { status: "error", error: "Provider unavailable" },
      },
    });
    const healthy = createSubagentStoreRunFixture({
      ...child,
      runId: "healthy-sibling-run",
      childSessionKey: "agent:main:subagent:healthy-sibling",
      execution: { status: "terminal", endedAt: 8, outcome: { status: "ok" } },
      completion: { required: true, resultText: "HEALTHY_RUNTIME_ONLY" },
    });
    subagentRuns.set(child.runId, child);
    subagentRuns.set(healthy.runId, healthy);
    persistRegistryFixture(
      new Map([
        [child.runId, child],
        [healthy.runId, healthy],
      ]),
    );
    // Direct completion inputs use typed events, unlike message-embedded settle cohorts.
    const events: NonNullable<TurnParams["request"]["internalEvents"]> = [child, healthy].map(
      (row) => ({
        type: "task_completion",
        source: "subagent",
        childSessionKey: row.childSessionKey,
        announceType: "completion",
        taskLabel: "child task",
        status: row.execution.outcome!.status,
        statusLabel: row.execution.outcome?.error ?? "completed",
        result: row.completion!.resultText!,
        replyInstruction: "Review the result.",
      }),
    );
    const provenance = {
      kind: "inter_session" as const,
      sourceSessionKey: child.childSessionKey,
      sourceTool: "subagent_announce",
    };
    const message = "Continue the OpenClaw runtime event.";
    let handoff: Promise<void> | undefined;
    const onInputCommitted = vi.fn<NonNullable<TurnParams["onInputCommitted"]>>((receipt) => {
      handoff = recordSubagentFailureHandoff({
        entries: [child, healthy],
        requester: receipt,
        assertCurrent: () => {},
      });
      return handoff;
    });
    const params = makeTurnParams(target, message, "announce:completion-handoff", {
      onInputCommitted,
      privateCompletion: privateCompletion ? true : undefined,
      inputProvenance: provenance,
      request: {
        expectedExistingSessionId: sessionId,
        deliver: false,
        internalEvents: events,
      },
    });
    await withTurn(params, async (recorder) => {
      const entered = createDeferred();
      const resume = createDeferred();
      const write = recorder.persistApproved({
        target: async () => {
          entered.resolve();
          await resume.promise;
          if (rejected) {
            throw new Error("Failure-bearing input write rejected");
          }
          return {
            ...target,
            sessionEntry: expectDefined(loadSessionEntry(target), "current requester"),
          };
        },
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          write,
          "Input write did not reach its target",
        );
        expect(onInputCommitted).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(target)).toEqual([]);
        expect(
          loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.failureHandoff,
        ).toBeUndefined();
      } finally {
        resume.resolve();
      }
      if (rejected) {
        await expect(write).rejects.toThrow("Failure-bearing input write rejected");
        expect(onInputCommitted).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(target)).toEqual([]);
        expect(
          loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.failureHandoff,
        ).toBeUndefined();
        return;
      }
      expect(await write).toMatchObject({ appended: true });
      await handoff;
      expect(onInputCommitted).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionKey,
          sessionId,
          idempotencyKey: "announce:completion-handoff:user",
        }),
      );
      expect(
        loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.failureHandoff,
      ).toMatchObject({ requesterSessionKey: sessionKey, requesterSessionId: sessionId });
      // The later runtime-context carrier has not been appended. Custody must
      // already include cause and progress, even if that later write never succeeds.
      const committedEvents = await loadTranscriptEvents(target);
      const messages = committedEvents.filter(
        (event) => isIndexedSessionEntry(event) && event.type === "message",
      );
      expect(messages).toMatchObject([
        {
          message: {
            role: "user",
            display: false,
            provenance,
            content: expect.stringContaining("Provider unavailable"),
          },
        },
      ]);
      expect(JSON.stringify(messages)).toContain("found the failing request.");
      expect(JSON.stringify(committedEvents)).not.toContain("HEALTHY_RUNTIME_ONLY");
      expect(
        events.some(
          (event) => event.status === "ok" && event.result.includes("HEALTHY_RUNTIME_ONLY"),
        ),
      ).toBe(true);
      expect(
        loadSubagentRegistryFromSqlite().get(healthy.runId)?.delivery?.failureHandoff,
      ).toBeUndefined();
      const manager = await SessionManager.openAsync(target, state.sessionsDir());
      const contextEntered = createDeferred();
      const releaseContext = createDeferred();
      const predecessor = runSessionManagerWrite(manager, async () => {
        contextEntered.resolve();
        await releaseContext.promise;
      });
      await contextEntered.promise;
      let contextCurrent = true;
      const contextWrite = withSessionManagerWriteAssertion(
        manager,
        () => {
          if (!contextCurrent) {
            throw new Error("Runtime context write rejected");
          }
        },
        () =>
          manager.appendCustomMessageEntryAsync(
            OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
            "Later runtime-context copy",
            false,
          ),
      );
      try {
        // The real manager queue delays the context, while the committed input
        // and custody receipt already retain both diagnostic facts.
        expect(await loadTranscriptEvents(target)).toEqual(committedEvents);
      } finally {
        contextCurrent = false;
        releaseContext.resolve();
        await expect(contextWrite).rejects.toThrow("Runtime context write rejected");
        await predecessor;
      }
      expect(await loadTranscriptEvents(target)).toEqual(committedEvents);
      expect(
        loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.failureHandoff,
      ).toMatchObject({ requesterSessionKey: sessionKey, requesterSessionId: sessionId });
      expect(recorder.getProcessingCompletion?.()).toBeUndefined();
      await recorder.persistApproved();
      expect(onInputCommitted).toHaveBeenCalledOnce();
    });
  },
);

it.each(["Original requester", null])(
  "retains accepted sender presentation after a profile rename (%s)",
  async (originalName) => {
    const sessionKey = "agent:main:private-sender";
    const sessionId = "private-sender-session";
    const runId = "announce:private-sender";
    const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const profileOptions = {
      path: path.resolve(fixture.sessionsDir(), "../../../state/openclaw.sqlite"),
    };
    const profile = await ensureCanonicalUserProfileForEmail(
      "private-sender@example.test",
      profileOptions,
    );
    const rename = (name: string | null) =>
      setCanonicalUserProfileDisplayName(profile.id, name, profileOptions);
    const { profile: original } = await rename(originalName);
    const clientFor = (displayName: string | null, profileId = profile.id) =>
      createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: {
          profileId,
          displayName,
          avatarRevision: "0",
          hasAvatar: false,
          updatedAt: original.updatedAt,
        },
      });
    const params = makeTurnParams(target, "Retained private result", runId, {
      privateCompletion: true,
      request: {
        expectedExistingSessionId: sessionId,
        deliver: false,
      },
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "subagent_announce",
        sourceSessionKey: "agent:main:subagent:sender-child",
      },
      client: clientFor(original.displayName),
    });
    await withTurn(params, async (recorder) => {
      const input = expectDefined(recorder.getPendingInputMessage?.(), "accepted input");
      expect(input["__openclaw"]).toMatchObject({ senderId: profile.id, senderIsOwner: false });
      if (originalName === null) {
        expect(input["__openclaw"]).not.toHaveProperty("senderName");
      } else {
        expect(input["__openclaw"]).toHaveProperty("senderName", originalName);
      }
      const { profile: renamed } = await rename("Renamed requester");
      const retryParams = { ...params, client: clientFor(renamed.displayName) };
      expect(recorder.getPendingInputMessage?.()).toEqual(input);
      const retained = await pendingInputs.listSessionPendingInputs(target);
      expect(retained.items).toMatchObject([{ state: "queued", message: input }]);
      const prepareAndRelease = (candidate: TurnParams) => withTurn(candidate, async () => {});
      // A renamed connection still matches the accepted input, but cannot take its live custody.
      await expect(prepareAndRelease(retryParams)).rejects.toThrow("already admitted");
      for (const mismatch of [
        { message: "Changed result", effectiveTranscriptInputText: "Changed result" },
        { client: clientFor(original.displayName, "different-profile") },
      ]) {
        await expect(prepareAndRelease({ ...retryParams, ...mismatch })).rejects.toThrow(
          "conflicts with the accepted input",
        );
      }
      const readSubmitted = pendingInputs.readSessionSubmittedInput;
      let current = true;
      using _ = vi
        .spyOn(pendingInputs, "readSessionSubmittedInput")
        .mockImplementationOnce(async (...args) => {
          const submitted = await readSubmitted(...args);
          current = false;
          return submitted;
        });
      await expect(
        prepareAndRelease({
          ...retryParams,
          assertCurrent: () => {
            if (!current) {
              throw new Error("Private source revoked");
            }
          },
        }),
      ).rejects.toThrow("Private source revoked");
      expect(await pendingInputs.listSessionPendingInputs(target)).toEqual(retained);
      expect(await loadTranscriptEvents(target)).toEqual([]);
    });
  },
);
