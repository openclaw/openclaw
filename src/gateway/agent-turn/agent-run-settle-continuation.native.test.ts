import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { buildRequesterSettleWakeIdentity } from "../../agents/subagents/registry/subagent-requester-settle-identity.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withSessionSendDelivery, type SessionSendDelivery } from "../session-send-delivery.js";
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

describe("requester-settle processing survives later user turns", () => {
  const fixture = useTempSessionsFixture("settle-continuation-native-");
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
    prepareAgentRunUserTurn({
      assertCurrent: () => {},
      onUserTurnMediaPersisted: () => {},
      assertCompletionCurrent: () => {},
      settleWakeReplay: { sourceSessionKeys: [sourceSessionKey], assertCurrent: () => {} },
      getAbortStopReason: () => "rpc",
      request,
      cfg: { session: { store: fixture.storePath() } },
      resolvedSessionKey: sessionKey,
      admittedSessionId: sessionId,
      activeSessionAgentId: "main",
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: false,
      message,
      effectiveTranscriptInputText: message,
      images: [],
      offloadedRefs: [],
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey,
        sourceTool: "subagent_settle",
        sourceChannel: "internal",
      },
      runId,
      client: null,
      context: { ...preparationContext, logGateway },
      ...overrides,
    });
  const assistant = (stopReason: "toolUse" | "stop", text = "") => ({
    ...makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp: 2, stopReason }),
    __openclaw: { runId },
  });
  type Prepared = Awaited<ReturnType<typeof prepare>>;
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
  const expectCompletedReplays = async (
    before: Awaited<ReturnType<typeof loadTranscriptEvents>>,
    prepareReplay = prepare,
    count = 1,
  ) => {
    rotateAgentEventLifecycleGeneration();
    for (let duplicate = 0; duplicate < count; duplicate++) {
      const replay = await prepareReplay();
      expect(completion(replay)).toMatchObject({ reason: "completed", status: "ok" });
      await expectAcknowledgement(replay, {
        status: "ok",
        summary: "completed",
        inputProcessingCompleted: true,
      });
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
        await expectAcknowledgement(retry, {
          status: "ok",
          summary: "completed",
          inputProcessingCompleted: true,
        });
      } else {
        expectNoReconciliation(retry);
        expect(await retry.recorder!.persistApproved()).toMatchObject({ appended: true });
        await complete(retry);
      }
      await release(retry);
      const users = (await loadTranscriptEvents(scope())).filter(
        (entry) =>
          isIndexedSessionEntry(entry) && entry.type === "message" && entry.message.role === "user",
      );
      expect(users).toHaveLength(privateCompletion ? 1 : 2);
      expect(reads.command).not.toHaveBeenCalled();
    },
  );

  it("reconciles one completed yielded input after two newer finished turns without reopening it", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    await manager.appendMessageAsync(assistant("toolUse"));
    await manager.appendCustomMessageEntryAsync("openclaw.sessions_yield", "", false, { runId });
    const context = createAgentTurnTestContext();
    const entry = createTestRpcSource(
      {
        sessionKey,
        sessionId,
        operationalRunInstance: { runId, instanceId: "settle-native-instance" },
      },
      runId,
    );
    rpcSourceTesting.set(runId, entry);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      admittedRunEntry: entry,
      ingressOpts: {
        message: original.message,
        sessionKey,
        allowModelOverride: false,
        userTurnTranscriptRecorder: original.recorder,
        abortSignal: entry.input.abortSignal,
      },
      runId,
      dedupeKeys: [],
      abortController: testRpcSourceController(entry),
      cleanupAbortController: () => {
        rpcSourceTesting.deleteExpected(runId, entry);
      },
      io: { emitAcceptance: vi.fn(), emitFinal },
      context,
    });
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
    await expectCompletedReplays(before, prepare, 2);
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

  it("retains legitimate unconsumed interrupted input instead of inferring processing completion", async () => {
    const original = await prepare();
    await release(original);
    rotateAgentEventLifecycleGeneration();
    const resumed = await prepare();
    expect(completion(resumed)).toBeUndefined();
    expect(await resumed.recorder!.persistApproved()).toMatchObject({ appended: true });
    await complete(resumed);
    await release(resumed);
    const users = (await loadTranscriptEvents(scope())).filter(
      (entry) =>
        isIndexedSessionEntry(entry) && entry.type === "message" && entry.message.role === "user",
    );
    expect(users).toHaveLength(1);
  });

  it("never infers completion for legacy committed input and preserves its current-turn refusal", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    await release(original);
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    await appendNewerTurn(manager, "newer:user", "Newer request");
    const before = await loadTranscriptEvents(scope());
    rotateAgentEventLifecycleGeneration();
    const replay = await prepare();
    expectNoReconciliation(replay);
    await expect(
      manager.appendMessageAsync(replay.recorder!.getPendingInputMessage!()!),
    ).rejects.toThrow("outside the current turn");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await release(replay);
  });

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
      const entry = createTestRpcSource(
        {
          sessionKey,
          sessionId,
          operationalRunInstance: { runId, instanceId: "settle-timeout-instance" },
        },
        runId,
      );
      rpcSourceTesting.set(runId, entry);
      const controller = testRpcSourceController(entry);
      const original = await prepare({
        abortSignal: controller.signal,
        getAbortStopReason: () => "timeout",
      });
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
      const cleanupAbortController = vi.fn(() => {
        rpcSourceTesting.deleteExpected(runId, entry);
      });
      const emitFinal = vi.fn();
      const execution = withSessionTurn(
        { sessionKey, sessionId, target: entry.input.target, controllerInput: entry.input },
        () =>
          dispatchAgentRunFromGateway({
            admittedRunEntry: entry,
            ingressOpts: {
              message: original.message,
              sessionKey,
              allowModelOverride: false,
              userTurnTranscriptRecorder: original.recorder,
              abortSignal: controller.signal,
            },
            runId,
            dedupeKeys: [],
            abortController: controller,
            cleanupAbortController,
            io: { emitAcceptance: vi.fn(), emitFinal },
            context: createAgentTurnTestContext(),
          }),
      );
      try {
        await awaitGateBeforeSettlement(
          producerEntered.promise,
          execution,
          "Timeout continuation did not enter its producer",
        );
        controller.abort(new DOMException("Synthetic producer deadline", "TimeoutError"));
        await original.recorder!.waitForPendingInputSettlement!();
        expect(original.recorder!.getProcessingCompletion!()).toBeUndefined();
        expect(cleanupAbortController).not.toHaveBeenCalled();
        expect(emitFinal).not.toHaveBeenCalled();
        finishProducer.resolve();
        await execution;
        await original.recorder!.waitForPendingInputSettlement!();
        expect(original.recorder!.getProcessingCompletion!()).toMatchObject({
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

  it("preserves durable peer-delivery success and duplicate reconciliation", async () => {
    const delivery: SessionSendDelivery = {
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
    ).toEqual(delivery);
    await complete(original);
    await release(original);
    const before = await loadTranscriptEvents(scope());
    await expectCompletedReplays(before, preparePeer);
    expect(reads.command).not.toHaveBeenCalled();
  });
});
