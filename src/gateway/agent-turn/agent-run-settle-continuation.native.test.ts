// Native admission, transcript promotion and durable completion; no model or tools execute.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildAgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { isIndexedSessionEntry } from "../../config/sessions/session-entry-codec.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { completeUserTurnProcessing } from "../../sessions/user-turn-transcript-processing.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
import { withSessionSendDelivery, type SessionSendDelivery } from "../session-send-delivery.js";
import { dispatchAgentRunFromGateway } from "./agent-run-dispatch.js";
import { createTrackedDispatch } from "./agent-run-dispatch.test-support.js";
import {
  prepareAgentRunUserTurn,
  reconcileAgentRunUserTurnCompletion,
  releasePreparedAgentRunUserTurn,
} from "./agent-run-user-turn.js";
import type { AgentTurnIo } from "./types.js";

const reads = vi.hoisted(() => ({ command: vi.fn() }));
// mock-isolation: Keep model/tools outside this regression; the Gateway terminal dispatcher stays native.
vi.mock("../../commands/agent.js", () => ({ agentCommandFromGatewayIngress: reads.command }));

describe("requester-settle processing survives later user turns", () => {
  const fixture = useTempSessionsFixture("settle-continuation-native-");
  const sessionKey = "agent:main:settle-continuation";
  const sessionId = "settle-continuation-session";
  const sourceSessionKey = "agent:main:subagent:completed-child";
  const runId = "announce:requester-settle:main:agent:main:settle-continuation:child:yield-1";
  const scope = () => ({ agentId: "main", sessionKey, sessionId, storePath: fixture.storePath() });
  const preparationContext = createTrackedDispatch().context;
  const logGateway = { ...preparationContext.logGateway, warn: vi.fn() };
  const prepare = (
    signal?: AbortSignal,
    assertCompletionCurrent = () => {},
    overrides: Partial<Parameters<typeof prepareAgentRunUserTurn>[0]> = {},
  ) =>
    prepareAgentRunUserTurn({
      assertCurrent: () => {},
      onUserTurnMediaPersisted: () => {},
      assertCompletionCurrent,
      settleWakeReplay: { sourceSessionKeys: [sourceSessionKey], assertCurrent: () => {} },
      abortSignal: signal,
      getAbortStopReason: () => "rpc",
      request: {
        message: "Synthesize the completed child result",
        idempotencyKey: runId,
        deliver: false,
      },
      cfg: { session: { store: fixture.storePath() } },
      resolvedSessionKey: sessionKey,
      admittedSessionId: sessionId,
      activeSessionAgentId: "main",
      suppressVisibleSessionEffects: false,
      requestedPromptPersistenceSuppression: false,
      canUseInternalRuntimeHandoff: false,
      message: "Synthesize the completed child result",
      effectiveTranscriptInputText: "Synthesize the completed child result",
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
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "messages" as const,
    provider: "anthropic" as const,
    model: "sonnet-4.6",
    usage: createZeroUsageFixture(),
    timestamp: 2,
    stopReason,
    __openclaw: { runId },
  });
  beforeEach(async () => {
    logGateway.warn.mockClear();
    reads.command.mockReset().mockResolvedValue({ payloads: [], meta: { yielded: true } });
    const entry = { sessionId, updatedAt: 1 };
    await upsertSessionEntryCore(scope(), entry);
  });

  it("reconciles one completed yielded input after two newer finished turns without reopening it", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    await manager.appendMessageAsync(assistant("toolUse"));
    await manager.appendCustomMessageEntryAsync("openclaw.sessions_yield", "", false, { runId });
    const dispatch = createTrackedDispatch();
    dispatch.context.chatAbortControllers.clear();
    const entry = {
      ...dispatch.entry,
      sessionKey,
      sessionId,
      operationalRunInstance: { runId, instanceId: "settle-native-instance" },
    };
    dispatch.context.chatAbortControllers.set(runId, entry);
    const emitFinal = vi.fn();
    await dispatchAgentRunFromGateway({
      admittedRunEntry: entry,
      ingressOpts: {
        message: original.message,
        sessionKey,
        allowModelOverride: false,
        userTurnTranscriptRecorder: original.recorder,
        abortSignal: entry.controller.signal,
      },
      runId,
      dedupeKeys: [],
      abortController: entry.controller,
      cleanupAbortController: () => {
        dispatch.context.chatAbortControllers.delete(runId);
      },
      io: { emitAcceptance: vi.fn(), emitFinal },
      context: dispatch.context,
    });
    expect(emitFinal).toHaveBeenCalledWith(
      [true, expect.objectContaining({ status: "ok", inputProcessingCompleted: true }), undefined],
      { runId },
    );
    const completed = original.recorder!.getProcessingCompletion!();
    await releasePreparedAgentRunUserTurn(original);
    for (const key of ["newer-one:user", "newer-two:user"]) {
      const newerUser: PersistedUserTurnMessage = {
        role: "user",
        content: "New user request",
        timestamp: 3,
        idempotencyKey: key,
      };
      await manager.appendMessageAsync(newerUser);
      await manager.appendMessageAsync(assistant("stop", "New user request finished"));
    }
    const before = await loadTranscriptEvents(scope());
    // This is the original failure boundary, not a readiness error or an in-memory-only fixture.
    await expect(
      manager.appendMessageAsync(original.recorder!.getPendingInputMessage!()!),
    ).rejects.toThrow("outside the current turn");
    expect(completed).toMatchObject({ reason: "completed", status: "ok" });
    rotateAgentEventLifecycleGeneration();
    for (let duplicate = 0; duplicate < 2; duplicate++) {
      const replay = await prepare();
      const cleanup = vi.fn(async () => {});
      const emitAcceptance = vi.fn();
      expect(replay.recorder!.getProcessingCompletion!()).toMatchObject({
        reason: "completed",
        status: "ok",
      });
      await reconcileAgentRunUserTurnCompletion(replay, { runId }, cleanup, {
        emitAcceptance,
        emitFinal: vi.fn(),
      } satisfies AgentTurnIo);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(emitAcceptance).toHaveBeenCalledWith(
        expect.arrayContaining([
          true,
          expect.objectContaining({ inputProcessingCompleted: true, status: "ok" }),
        ]),
        { runId },
      );
      await releasePreparedAgentRunUserTurn(replay);
    }
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    expect(reads.command).toHaveBeenCalledOnce();
  });

  it.each([
    { privateCompletion: false, consumed: false },
    { privateCompletion: false, consumed: true },
    { privateCompletion: true, consumed: false },
    { privateCompletion: true, consumed: true },
  ])(
    "durably cancels settlement (private=$privateCompletion, consumed=$consumed) without acknowledging success",
    async ({ privateCompletion, consumed }) => {
      const controller = new AbortController();
      const original = await prepare(controller.signal, () => {}, {
        privateCompletion: privateCompletion ? true : undefined,
        request: {
          message: "Synthesize the completed child result",
          idempotencyKey: runId,
          deliver: false,
          expectedExistingSessionId: sessionId,
        },
      });
      if (consumed) {
        await original.recorder!.persistApproved();
      }
      controller.abort();
      await original.recorder!.waitForPendingInputSettlement!();
      expect(original.recorder!.getProcessingCompletion!()).toMatchObject({
        reason: "cancelled",
        status: "error",
      });
      await releasePreparedAgentRunUserTurn(original, "cancelled");
      rotateAgentEventLifecycleGeneration();
      const replay = await prepare();
      expect(replay.recorder!.getProcessingCompletion!()).toMatchObject({ reason: "cancelled" });
      const emitAcceptance = vi.fn();
      await reconcileAgentRunUserTurnCompletion(replay, { runId }, async () => {}, {
        emitAcceptance,
        emitFinal: vi.fn(),
      } satisfies AgentTurnIo);
      expect(emitAcceptance).toHaveBeenCalledWith(
        [true, { runId, status: "error", summary: "cancelled", stopReason: "rpc" }, undefined],
        { runId },
      );
      expect(reads.command).not.toHaveBeenCalled();
      await releasePreparedAgentRunUserTurn(replay, "cancelled");
    },
  );

  it("retains legitimate unconsumed interrupted input instead of inferring processing completion", async () => {
    const original = await prepare();
    await releasePreparedAgentRunUserTurn(original);
    rotateAgentEventLifecycleGeneration();
    const resumed = await prepare();
    expect(resumed.recorder!.getProcessingCompletion!()).toBeUndefined();
    expect(await resumed.recorder!.persistApproved()).toMatchObject({ appended: true });
    await completeUserTurnProcessing(
      resumed.recorder,
      buildAgentRunTerminalOutcome({ status: "ok" }),
    );
    await releasePreparedAgentRunUserTurn(resumed);
    const users = (await loadTranscriptEvents(scope())).filter(
      (entry) =>
        isIndexedSessionEntry(entry) && entry.type === "message" && entry.message.role === "user",
    );
    expect(users).toHaveLength(1);
  });

  it("never infers completion for legacy committed input and preserves its current-turn refusal", async () => {
    const original = await prepare();
    await original.recorder!.persistApproved();
    await releasePreparedAgentRunUserTurn(original);
    const manager = await SessionManager.openAsync(scope(), fixture.sessionsDir());
    const newerUser: PersistedUserTurnMessage = {
      role: "user",
      content: "Newer request",
      timestamp: 3,
      idempotencyKey: "newer:user",
    };
    await manager.appendMessageAsync(newerUser);
    await manager.appendMessageAsync(assistant("stop", "Newer answer"));
    const before = await loadTranscriptEvents(scope());
    rotateAgentEventLifecycleGeneration();
    const replay = await prepare();
    expect(replay.recorder!.getProcessingCompletion!()).toBeUndefined();
    const emitAcceptance = vi.fn();
    const cleanup = vi.fn(async () => {});
    expect(
      reconcileAgentRunUserTurnCompletion(replay, { runId }, cleanup, {
        emitAcceptance,
        emitFinal: vi.fn(),
      } satisfies AgentTurnIo),
    ).toBeUndefined();
    expect(cleanup).not.toHaveBeenCalled();
    expect(emitAcceptance).not.toHaveBeenCalled();
    await expect(
      manager.appendMessageAsync(replay.recorder!.getPendingInputMessage!()!),
    ).rejects.toThrow("outside the current turn");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await releasePreparedAgentRunUserTurn(replay);
  });

  it("cannot publish a cancellation after losing completion authority", async () => {
    let current = true;
    const controller = new AbortController();
    const original = await prepare(controller.signal, () => {
      if (!current) {
        throw new Error("completion authority revoked");
      }
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
    expect(original.recorder!.getProcessingCompletion!()).toBeUndefined();
    await expect(
      completeUserTurnProcessing(original.recorder, buildAgentRunTerminalOutcome({ status: "ok" })),
    ).rejects.toThrow("completion authority revoked");
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await expect(releasePreparedAgentRunUserTurn(original)).rejects.toThrow(
      "completion authority revoked",
    );
  });
  it.each([false, true])(
    "preserves producer timeout grace (producer settles=%s)",
    async (producerSettles) => {
      let finishGrace: (() => void) | undefined;
      const controller = new AbortController();
      const original = await prepare(controller.signal, () => {}, {
        getAbortStopReason: () => "timeout",
        deferTimeoutCompletion: (settle) => {
          finishGrace = settle;
          return true;
        },
      });
      await original.recorder!.persistApproved();
      controller.abort();
      await original.recorder!.waitForPendingInputSettlement!();
      expect(original.recorder!.getProcessingCompletion!()).toBeUndefined();
      expect(finishGrace).toBeTypeOf("function");
      if (producerSettles) {
        await completeUserTurnProcessing(
          original.recorder,
          buildAgentRunTerminalOutcome({
            status: "timeout",
            stopReason: "timeout",
            timeoutPhase: "provider",
            providerStarted: true,
          }),
        );
      }
      finishGrace!();
      await original.recorder!.waitForPendingInputSettlement!();
      expect(original.recorder!.getProcessingCompletion!()).toMatchObject({
        status: "timeout",
        reason: producerSettles ? "hard_timeout" : "timed_out",
      });
      await releasePreparedAgentRunUserTurn(original);
      rotateAgentEventLifecycleGeneration();
      const replay = await prepare();
      // Timeouts remain nonfinal; they must not become a successful duplicate acknowledgement.
      expect(replay.recorder!.getProcessingCompletion!()).toBeUndefined();
      const emitAcceptance = vi.fn();
      const cleanup = vi.fn(async () => {});
      expect(
        reconcileAgentRunUserTurnCompletion(replay, { runId }, cleanup, {
          emitAcceptance,
          emitFinal: vi.fn(),
        }),
      ).toBeUndefined();
      expect(emitAcceptance).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      await releasePreparedAgentRunUserTurn(replay);
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
        prepare(undefined, () => {}, {
          settleWakeReplay: undefined,
          inputProvenance: { kind: "inter_session", sourceSessionKey, sourceTool: "sessions_send" },
        }),
      );
    const original = await preparePeer();
    await original.recorder!.persistApproved();
    expect(
      original.recorder!.getPendingInputMessage!()?.["__openclaw"]?.sessionSendDelivery,
    ).toEqual(delivery);
    await completeUserTurnProcessing(
      original.recorder,
      buildAgentRunTerminalOutcome({ status: "ok" }),
    );
    await releasePreparedAgentRunUserTurn(original);
    const before = await loadTranscriptEvents(scope());
    rotateAgentEventLifecycleGeneration();
    const replay = await preparePeer();
    const emitAcceptance = vi.fn();
    await reconcileAgentRunUserTurnCompletion(replay, { runId }, async () => {}, {
      emitAcceptance,
      emitFinal: vi.fn(),
    });
    expect(emitAcceptance).toHaveBeenCalledWith(
      [
        true,
        { runId, status: "ok", summary: "completed", inputProcessingCompleted: true },
        undefined,
      ],
      { runId },
    );
    expect(await loadTranscriptEvents(scope())).toEqual(before);
    await releasePreparedAgentRunUserTurn(replay);
    expect(reads.command).not.toHaveBeenCalled();
  });
});
