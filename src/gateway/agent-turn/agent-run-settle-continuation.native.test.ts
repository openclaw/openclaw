import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../../agents/restart-recovery-prompt.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as pendingInputs from "../../config/sessions/session-accessor.pending-inputs.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { rpcSourceTesting } from "../../sessions/session-lifecycle-admission.test-support.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileDisplayName,
} from "../../state/user-profile-writes.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { withSessionSendDelivery, type SessionSendDelivery } from "../session-send-delivery.js";
import { createGate, expectCalls } from "./agent-owner.test-support.js";
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
const interSession = (sourceTool: string, sourceSessionKey: string) => ({
  kind: "inter_session" as const,
  sourceTool,
  sourceSessionKey,
});
function makeTurnParams(
  target: Awaited<ReturnType<typeof createTarget>>,
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

const fixture = useTempSessionsFixture("settle-continuation-native-");
type Scope = Parameters<typeof loadTranscriptEvents>[0];
async function messageEvents(scope: Scope) {
  return (await loadTranscriptEvents(scope)).filter(
    (entry) => isIndexedSessionEntry(entry) && entry.type === "message",
  );
}
async function expectUserInputs(scope: Parameters<typeof loadTranscriptEvents>[0], count: number) {
  expect(
    (await messageEvents(scope)).filter((entry) => entry.message.role === "user"),
  ).toHaveLength(count);
}
async function createTarget(sessionKey: string, sessionId: string) {
  const target = { agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() };
  await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
  return target;
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
          ...interSession("subagent_settle", sourceSessionKey),
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
  const dispatch = (instanceId: string) => {
    const entry = createTestRpcSource(
      { sessionKey, sessionId, operationalRunInstance: { runId, instanceId } },
      runId,
    );
    rpcSourceTesting.set(runId, entry);
    const controller = testRpcSourceController(entry);
    const cleanupAbortController = vi.fn(() => {
      rpcSourceTesting.deleteExpected(runId, entry);
    });
    const emitFinal = vi.fn();
    const execute = (turn: Prepared) =>
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
  const completedPayload = { status: "ok", summary: "completed", inputProcessingCompleted: true };
  type Prepared = Awaited<ReturnType<typeof prepare>>;
  const completion = (turn: Prepared) => turn.recorder!.getProcessingCompletion!();
  const complete = (
    turn: Prepared,
    outcome: Parameters<typeof buildAgentRunTerminalOutcome>[0] = { status: "ok" },
  ) => completeUserTurnProcessing(turn.recorder, buildAgentRunTerminalOutcome(outcome));
  const prepareAfterRestart = () => {
    rotateAgentEventLifecycleGeneration();
    return prepare();
  };
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
    expectCalls(0, cleanup, io.emitAcceptance);
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
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
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
      const retryRunId = privateCompletion ? runId : `${runId}:retry-1`;
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
    },
  );

  it("reconciles one completed yielded input after two newer finished turns without reopening it", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    await manager.appendMessageAsync(assistant("toolUse"));
    await manager.appendCustomMessageEntryAsync("openclaw.sessions_yield", "", false, { runId });
    const { emitFinal, execute } = dispatch("settle-native-instance");
    await execute(original);
    expect(emitFinal).toHaveBeenCalledWith(
      [true, expect.objectContaining({ status: "ok", inputProcessingCompleted: true }), undefined],
      { runId },
    );
    await release(original);
    for (const key of ["newer-one:user", "newer-two:user"]) {
      await appendNewerTurn(manager, key, "New user request");
    }
    const before = await loadTranscriptEvents(scope());
    await expect(
      manager.appendMessageAsync(original.recorder!.getPendingInputMessage!()!),
    ).rejects.toThrow("outside the current turn");
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
      const resumed = await prepareAfterRestart();
      expect(completion(resumed)).toMatchObject({ reason: "cancelled" });
      await expectAcknowledgement(resumed, {
        status: "error",
        summary: "cancelled",
        stopReason: "rpc",
      });
      await release(resumed, "cancelled");
    },
  );

  it.each([false, true])(
    "resumes interrupted input without inferring completion (consumed=%s)",
    async (consumed) => {
      const original = await prepare();
      if (consumed) {
        await original.recorder!.persistApproved();
      } else {
        expect(original.runtimeContextFragments).toBeUndefined();
      }
      await release(original);
      const resumed = await prepareAfterRestart();
      expect(resumed.runtimeContextFragments).toEqual([
        { kind: "runtime-instruction", text: RESTART_RECOVERY_INTERRUPTION_NOTE },
      ]);
      expect(resumed.message).toBe(message);
      expectNoReconciliation(resumed);
      expect(await resumed.recorder!.persistApproved()).toMatchObject({ appended: !consumed });
      if (!consumed) {
        await complete(resumed);
        await release(resumed);
        await expectUserInputs(scope(), 1);
        return;
      }
      await release(resumed);
      const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
      await appendNewerTurn(manager, "newer:user", "Newer request");
      const before = await loadTranscriptEvents(scope());
      const resumedAgain = await prepareAfterRestart();
      expectNoReconciliation(resumedAgain);
      await expect(
        manager.appendMessageAsync(resumedAgain.recorder!.getPendingInputMessage!()!),
      ).rejects.toThrow("outside the current turn");
      expect(await loadTranscriptEvents(scope())).toEqual(before);
      await release(resumedAgain);
    },
  );

  it("cannot publish a cancellation after losing completion authority", async () => {
    const authority = new AbortController();
    const controller = new AbortController();
    const original = await prepare({
      abortSignal: controller.signal,
      assertCompletionCurrent: () => authority.signal.throwIfAborted(),
    });
    await original.recorder!.persistApproved();
    const before = await loadTranscriptEvents(scope());
    authority.abort(new Error("completion authority revoked"));
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
      const { entry, controller, cleanupAbortController, emitFinal, execute } = dispatch("timeout");
      const original = await prepare({
        abortSignal: controller.signal,
        getAbortStopReason: () => "timeout",
      });
      await original.recorder!.persistApproved();
      const producer = createGate();
      reads.command.mockImplementationOnce(async () => {
        await producer.wait();
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
        () => execute(original),
      );
      try {
        await awaitGateBeforeSettlement(
          producer.entered,
          execution,
          "Timeout continuation did not enter its producer",
        );
        controller.abort(new DOMException("Synthetic producer deadline", "TimeoutError"));
        await original.recorder!.waitForPendingInputSettlement!();
        expect(completion(original)).toBeUndefined();
        expectCalls(0, cleanupAbortController, emitFinal);
        producer.resolve();
        await execution;
        await original.recorder!.waitForPendingInputSettlement!();
        expect(completion(original)).toMatchObject({
          status: "timeout",
          reason: classified ? "hard_timeout" : "timed_out",
        });
        expect(cleanupAbortController).toHaveBeenCalledOnce();
      } finally {
        producer.resolve();
        await execution;
        await release(original);
      }
      const resumed = await prepareAfterRestart();
      // Timeouts remain nonfinal; they must not become a successful duplicate acknowledgement.
      expectNoReconciliation(resumed);
      await release(resumed);
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
          inputProvenance: interSession("sessions_send", sourceSessionKey),
        }),
      );
    const original = await preparePeer();
    await original.recorder!.persistApproved();
    expect(
      original.recorder!.getPendingInputMessage!()?.["__openclaw"]?.sessionSendDelivery,
    ).toEqual({ ...delivery, operatorSource: null });
    await complete(original);
    await release(original);
    const before = await loadTranscriptEvents(scope());
    await expectCompletedReplay(before, preparePeer);
  });
});

it("keeps the committed child target and later owner metadata through input persistence", async () => {
  const target = await createTarget("agent:main:subagent:fresh-child", "fresh-child-session");
  const { sessionId } = target;
  const sessionEntry = { sessionId, updatedAt: 1, label: "Created child" };
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
  const params = makeTurnParams(target, "Child task", "fresh-child-run", {
    cfg: { session: { store: reroutedTarget.storePath } },
    sessionEntry,
    freshChildStorePath: target.storePath,
  });
  await withTurn(params, async (recorder) => {
    expect(recorder.getPendingInputMessage?.()).toMatchObject({ content: "Child task" });
    expect(await loadTranscriptEvents(target)).toEqual([]);
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
    expect(await messageEvents(target)).toMatchObject([
      { message: { role: "user", content: "Child task" } },
    ]);
    expect(loadSessionEntry(target)).toMatchObject({ sessionId, label: "Renamed child" });
    expect(await loadTranscriptEvents(reroutedTarget)).toEqual([]);
  });
});

it("persists subagent completion handoff prompts as hidden inter-session turns", async () => {
  const target = await createTarget("agent:main:completion-handoff", "completion-handoff-session");
  const provenance = interSession("subagent_announce", "agent:main:subagent:child");
  const message = "Continue the OpenClaw runtime event.";
  const params = makeTurnParams(target, message, "announce:completion-handoff", {
    inputProvenance: provenance,
    request: {
      internalEvents: [
        {
          type: "task_completion",
          source: "subagent",
          childSessionKey: provenance.sourceSessionKey,
          childSessionId: "child-session-id",
          announceType: "completion",
          taskLabel: "child task",
          status: "ok",
          statusLabel: "completed",
          result: "child result",
          replyInstruction: "Deliver the child result.",
        },
      ],
    },
  });
  // The completion's runtime context is saved after this turn; replay needs the turn itself.
  await withTurn(params, async (recorder) => {
    expect(await recorder.persistApproved()).toMatchObject({ appended: true });
  });
  expect(await messageEvents(target)).toMatchObject([
    { message: { role: "user", display: false, content: message, provenance } },
  ]);
});

it.each(["Original requester", null])(
  "retains accepted sender presentation after a profile rename (%s)",
  async (originalName) => {
    const target = await createTarget("agent:main:private-sender", "private-sender-session");
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
    const params = makeTurnParams(target, "Retained private result", "announce:private-sender", {
      privateCompletion: true,
      request: {
        expectedExistingSessionId: target.sessionId,
        deliver: false,
      },
      inputProvenance: interSession("subagent_announce", "agent:main:subagent:sender-child"),
      client: clientFor(original.displayName),
    });
    const accepted = await withTurn(params, async (recorder) => {
      const input = expectDefined(recorder.getPendingInputMessage?.(), "accepted input");
      expect(input["__openclaw"]).toMatchObject({ senderId: profile.id, senderIsOwner: false });
      if (originalName === null) {
        expect(input["__openclaw"]).not.toHaveProperty("senderName");
      } else {
        expect(input["__openclaw"]).toHaveProperty("senderName", originalName);
      }
      await recorder.completeProcessingAsync!(
        buildAgentRunTerminalOutcome({ status: "error", stopReason: "restart" }),
      );
      return input;
    });
    const { profile: renamed } = await rename("Renamed requester");
    const replayParams = { ...params, client: clientFor(renamed.displayName) };
    await withTurn(replayParams, async (recorder) => {
      expect(recorder.getPendingInputMessage?.()).toEqual(accepted);
    });
    const retained = await pendingInputs.listSessionPendingInputs(target);
    expect(retained.items).toMatchObject([{ state: "interrupted", message: accepted }]);
    const prepareAndRelease = (candidate: TurnParams) => withTurn(candidate, async () => {});
    for (const mismatch of [
      { message: "Changed result", effectiveTranscriptInputText: "Changed result" },
      { client: clientFor(original.displayName, "different-profile") },
    ]) {
      await expect(prepareAndRelease({ ...replayParams, ...mismatch })).rejects.toThrow(
        "conflicts with the accepted input",
      );
    }
    const readSubmitted = pendingInputs.readSessionSubmittedInput;
    const authority = new AbortController();
    using _ = vi
      .spyOn(pendingInputs, "readSessionSubmittedInput")
      .mockImplementationOnce(async (...args) => {
        const submitted = await readSubmitted(...args);
        authority.abort(new Error("Private source revoked"));
        return submitted;
      });
    await expect(
      prepareAndRelease({
        ...replayParams,
        assertCurrent: () => authority.signal.throwIfAborted(),
      }),
    ).rejects.toThrow("Private source revoked");
    expect(await pendingInputs.listSessionPendingInputs(target)).toEqual(retained);
    expect(await loadTranscriptEvents(target)).toEqual([]);
  },
);
