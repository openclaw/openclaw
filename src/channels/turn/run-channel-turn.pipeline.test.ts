// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { createMockSubsystemLogger } from "../../../test/helpers/mock-subsystem-logger.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { noteDispatchProcessedOutcome } from "../../auto-reply/reply/dispatch-processed-outcome.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import type { DispatchReplyWithBufferedBlockDispatcher as Dispatch } from "../../auto-reply/reply/provider-dispatcher.types.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { getReplySystemEventContext } from "../../auto-reply/reply/system-event-session-key.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { withPluginServiceScheduler } from "../../plugins/service-scheduler-binding.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted as assertAdmitted,
  readAgentDatabaseAdmissionRefusal as readRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight as Preflight } from "../../state/openclaw-database-preflight.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../message-access/admission-evidence.js";
import { recordOutboundMessageIdentity } from "../message/outbound-echo.js";
import {
  hasVisibleChannelTurnDispatch,
  hasFinalChannelTurnDispatch,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";
import { runPreparedChannelTurn } from "./execution.js";
import { dispatchAssembledChannelTurn } from "./lifecycle.js";
import {
  createCtx,
  createRecordInboundSession,
  createDispatch,
  createReplyDispatchReceipt,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import { runChannelTurn } from "./run-channel-turn.js";
import * as fixture from "./turn-state.test-support.js";
import type {
  AssembledChannelTurn,
  ChannelTurnLogEvent,
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnPlan,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "./types.js";

const subsystemWarn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const makeLogger = (subsystem: string): import("../../logging/subsystem.js").SubsystemLogger =>
    createMockSubsystemLogger(subsystem, {
      isEnabled: () => true,
      warn: subsystemWarn,
      child: (name: string) => makeLogger(`${subsystem}/${name}`),
    });
  return {
    ...(await importOriginal<typeof import("../../logging/subsystem.js")>()),
    createSubsystemLogger: makeLogger,
  };
});

const {
  emitMessageSent,
  readRecentUserAssistantTextForSession: readRecent,
  recordInboundSessionCore: recordCore,
  dispatchReplyWithRoutedChannelDispatcherCore: dispatchCore,
} = channelTurnMocks;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let storePath: string;
function dispatchTestAssembledTurn(overrides: Partial<AssembledChannelTurn>) {
  return dispatchAssembledChannelTurn(
    fixture.assembledTurn(storePath, {
      channel: "feishu",
      ctxPayload: createCtx({ Surface: "feishu", Provider: "feishu" }),
      delivery: { deliver: async () => ({ visibleReplySent: true }) },
      ...overrides,
    }),
  );
}
function runDelivery(
  delivery: AssembledChannelTurn["delivery"],
  dispatch = createDispatch(),
  overrides: Partial<AssembledChannelTurn> = {},
) {
  return dispatchTestAssembledTurn({
    ...overrides,
    dispatchReplyWithBufferedBlockDispatcher: dispatch,
    delivery: { observeMessageSent: true, ...delivery },
  });
}

function pendingHistory() {
  return {
    isGroup: true,
    historyKey: "room",
    historyMap: new Map([["room", [{ sender: "Alice", body: "earlier message" }]]]),
    limit: 50,
  } satisfies ChannelTurnHistoryFinalizeOptions;
}
function prepared<T extends Partial<PreparedChannelTurn>>(overrides: T) {
  return {
    ...fixture.turnContext(storePath),
    runDispatch: vi.fn(async () => fixture.finalDispatch()),
    ...overrides,
  };
}
function routed(overrides: Partial<ChannelTurnPlan> = {}): ChannelTurnPlan {
  return {
    cfg: {},
    channel: "test",
    route: { agentId: "main", sessionKey: "agent:main:test:peer" },
    ctxPayload: createCtx(),
    delivery: { deliver: vi.fn() },
    ...overrides,
  };
}
function runAdapter(adapter: RunChannelTurnParams<unknown>["adapter"]) {
  return runChannelTurn({ channel: "test", raw: {}, adapter });
}
const ingest = () => ({ id: "msg-1", rawText: "hello" });

function createTurn(overrides: Partial<PreparedChannelTurn> = {}, observeOnly = false) {
  const onFinalize = vi.fn();
  const turn = prepared({
    runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped: vi.fn() },
    ...overrides,
  });
  const runTurn = (
    turnAdoptionLifecycle?: RunChannelTurnParams<unknown>["turnAdoptionLifecycle"],
  ) =>
    runChannelTurn({
      channel: "test",
      raw: {},
      turnAdoptionLifecycle,
      adapter: {
        ingest: () => ({ id: "msg-1", rawText: "hello" }),
        preflight: () =>
          observeOnly ? { kind: "observeOnly", reason: "broadcast-observer" } : undefined,
        resolveTurn: () => turn,
        onFinalize,
      },
    });
  const expectIdle = () => {
    expect(turn.recordInboundSession).not.toHaveBeenCalled();
    expect(turn.runDispatch).not.toHaveBeenCalled();
  };
  return { turn, run: runTurn, onFinalize, expectIdle };
}

describe("channel turn pipeline and finalization", () => {
  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-channel-turn-pipeline-"), "sessions.json");
    fixture.resetTurnState();
    readRecent.mockResolvedValue([]);
    recordCore.mockResolvedValue(undefined);
    dispatchCore.mockImplementation(createDispatch());
  });

  afterEach(fixture.resetTurnLogger);

  it("does not emit a second failure when a post-send observer throws", async () => {
    const observerError = new Error("observer failed");
    const onError = vi.fn();

    await expect(
      runDelivery({
        deliver: async () => ({ messageIds: ["om-visible"], visibleReplySent: true }),
        onDelivered: () => {
          throw observerError;
        },
        onError,
      }),
    ).rejects.toBe(observerError);

    fixture.expectMessagesSent(["reply", "om-visible"]);
    expect(onError).not.toHaveBeenCalled();
    expect(observerError).toMatchObject({ sentBeforeError: true, visibleReplySent: true });
  });

  it("observes early finalization rejection and reports the original failure", async () => {
    const { promise: finalization, reject: rejectFinalization } = createDeferred<never>();
    const catchSpy = vi.spyOn(finalization, "catch");
    const finalizationError = new Error("final edit failed", {
      cause: new Error("provider rejected edit"),
    });
    const onError = vi.fn();
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "requested final" }, fixture.finalInfo);
      expect(catchSpy).toHaveBeenCalledOnce();
      rejectFinalization(finalizationError);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      return fixture.finalDispatch();
    });

    await expect(
      runDelivery(
        {
          deliver: async () => ({ visibleReplySent: false, finalization }),
          onError,
        },
        dispatch,
      ),
    ).rejects.toBe(finalizationError);

    fixture.expectMessagesSent([
      "requested final",
      undefined,
      "final edit failed | provider rejected edit",
    ]);
    expect(onError).toHaveBeenCalledExactlyOnceWith(finalizationError, fixture.finalInfo);
  });

  it("preserves the visible partial error over other finalization and dispatch failures", async () => {
    const { promise: firstFinalization, reject: rejectFirst } = createDeferred<never>();
    const { promise: secondFinalization, reject: rejectSecond } = createDeferred<never>();
    const firstError = new Error("first finalization failed");
    const partialError = Object.assign(new Error("second finalization failed"), {
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: {
        content: "accepted second preview",
        messageIds: ["om-second-preview"],
        visibleReplySent: true,
      },
    });
    const deliver = vi
      .fn()
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: firstFinalization })
      .mockResolvedValueOnce({ visibleReplySent: false, finalization: secondFinalization });
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "first requested" }, fixture.finalInfo);
      await dispatcherOptions.deliver({ text: "second requested" }, fixture.finalInfo);
      rejectFirst(firstError);
      rejectSecond(partialError);
      throw new Error("stream close failed");
    });

    await expect(runDelivery({ deliver }, dispatch)).rejects.toBe(partialError);

    fixture.expectMessagesSent(
      ["first requested", undefined, "first finalization failed"],
      ["accepted second preview", "om-second-preview", "second finalization failed"],
    );
  });

  it("suppresses message_sent when the adapter proves provider dispatch never began", async () => {
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      try {
        await dispatcherOptions.deliver({ ...fixture.reply }, fixture.finalInfo);
      } catch {
        // The buffered dispatcher already owns delivery-error reporting.
      }
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });

    await runDelivery(
      {
        deliver: async () => {
          throw new PlatformMessageNotDispatchedError("local media load failed", {
            cause: new Error("missing file"),
          });
        },
      },
      dispatch,
    );

    expect(emitMessageSent).not.toHaveBeenCalled();
  });

  it("settles visible replies even when a suppression observer throws", async () => {
    const observerError = new Error("suppression observer failed");
    const finalized = {
      visibleReplySent: true,
      messageIds: ["om-public"],
      content: "public reply",
    };
    const deliver = vi.fn(async () => ({
      visibleReplySent: false,
      finalization: Promise.resolve(finalized),
    }));
    const onDelivered = vi.fn<NonNullable<AssembledChannelTurn["delivery"]["onDelivered"]>>(
      (payload) => {
        if (payload.text === "private reply") {
          throw observerError;
        }
      },
    );
    const dispatch = vi.fn<Dispatch>(async ({ dispatcherOptions }) => {
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      expect(dispatcher.sendFinalReply({ text: "private reply" })).toBe(false);
      expect(dispatcher.sendFinalReply({ text: "public reply" })).toBe(true);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return {
        queuedFinal: dispatcher.getQueuedCounts().final > 0,
        counts: dispatcher.getQueuedCounts(),
      };
    });

    const turn = runDelivery({ deliver, onDelivered }, dispatch, {
      channel: "test",
      routeSessionKey: "agent:main:test:peer",
      ctxPayload: createCtx(),
      replyPipeline: {
        transformReplyPayload: (payload) => (payload.text === "private reply" ? null : payload),
      },
    });

    await expect(turn).rejects.toBe(observerError);

    expect(deliver).toHaveBeenCalledExactlyOnceWith({ text: "public reply" }, fixture.finalInfo);
    expect(onDelivered).toHaveBeenCalledWith({ text: "private reply" }, fixture.finalInfo, {
      visibleReplySent: false,
      suppression: { reason: "channel_transform" },
    });
    expect(onDelivered).toHaveBeenCalledWith(
      { text: "public reply" },
      fixture.finalInfo,
      expect.objectContaining(finalized),
    );
    fixture.expectMessagesSent(["public reply", "om-public"]);
  });

  it("can record a target session without changing the command dispatch session", async () => {
    const log = vi.fn();
    const events: string[] = [];
    const recordInboundSession = createRecordInboundSession(events);
    const onAdopted = vi.fn(async () => {
      events.push("adopted");
    });
    const turnAdoptionLifecycle = { onAdopted };
    const dispatch = vi.fn<Dispatch>(async ({ ctx, replyOptions, dispatcherOptions }) => {
      expect(ctx).not.toHaveProperty("SystemEventSessionKey");
      expect(ctx.SessionKey).toBe(commandSessionKey);
      expect(getReplySystemEventContext({ ...replyOptions })?.sessionKey).toBe(routeSessionKey);
      events.push("dispatch");
      expect(replyOptions?.turnAdoptionLifecycle).toBe(turnAdoptionLifecycle);
      await replyOptions?.turnAdoptionLifecycle?.onAdopted();
      await dispatcherOptions.deliver({ ...fixture.reply }, fixture.finalInfo);
      return fixture.finalDispatch();
    });
    const routeSessionKey = "agent:main:telegram:group:42";
    const commandSessionKey = "agent:main:command:telegram:42";
    const targetSessionKey = "agent:main:telegram:group:42:topic:7";

    const result = await dispatchTestAssembledTurn({
      channel: "telegram",
      routeSessionKey,
      ctxPayload: createCtx({
        AgentId: "main",
        SessionKey: commandSessionKey,
        CommandTargetSessionKey: targetSessionKey,
        SessionTranscriptContext: { historyLimit: 1 },
      }),
      recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher: dispatch,
      turnAdoptionLifecycle,
      record: { sessionKey: targetSessionKey },
      log,
      afterRecord: async () => {
        events.push("afterRecord");
      },
    });

    expectDispatched(result);
    expect(events).toEqual(["record", "afterRecord", "dispatch", "adopted"]);
    expect(log).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    );
    expect(result).toMatchObject({
      routeSessionKey,
      ctxPayload: { SessionKey: commandSessionKey },
    });
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: targetSessionKey }),
    );
    expect(readRecent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", sessionKey: targetSessionKey, storePath }),
    );
  });

  it("rejects surrounding whitespace in an explicit record session", async () => {
    const historyMap = new Map([["room", [{ sender: "Alice", body: "pending" }]]]);
    const recordInboundSession = createRecordInboundSession();
    await expect(
      dispatchTestAssembledTurn({
        recordInboundSession,
        history: { isGroup: true, historyKey: "room", historyMap, limit: 1 },
        record: { sessionKey: " agent:main:telegram:group:42 " },
      }),
    ).rejects.toThrow("Channel turn record.sessionKey must not include surrounding whitespace.");
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(historyMap.get("room")).toStrictEqual([]);
  });

  it("keeps zero-visible diagnostic attribution internal", async () => {
    const log = vi.fn<(event: ChannelTurnLogEvent) => void>();
    const result = await runPreparedChannelTurn({
      ...fixture.turnContext(storePath),
      log,
      messageId: "msg-zero-cause",
      runDispatch: async () => {
        noteDispatchProcessedOutcome({ outcome: "skipped", reason: "duplicate" });
        return {
          ...fixture.finalDispatch(),
          settledReceipt: createReplyDispatchReceipt({ final: { deliveredNotVisible: 1 } }),
        };
      },
    });

    expectDispatched(result);
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("messageId=msg-zero-cause"));
    expect(subsystemWarn).toHaveBeenCalledWith(expect.stringContaining("cause=skipped:duplicate"));
    const warning = log.mock.calls
      .map(([event]) => event)
      .find((event) => event.reason === "zero-count-visible-dispatch");
    expect(warning).toBeDefined();
    expect(warning).not.toHaveProperty("cause");
  });

  it("does not warn for a steer deferred to the active run", async () => {
    const log = vi.fn();
    const signal = { deferredToActiveRun: "steer" } as const;
    const result = await runPreparedChannelTurn({
      ...fixture.turnContext(storePath),
      log,
      messageId: "msg-zero",
      runDispatch: async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
        ...signal,
      }),
    });
    expectDispatched(result);
    expect(result.dispatchResult).toMatchObject(signal);
    expect(log.mock.calls).not.toContainEqual([
      expect.objectContaining({ reason: "zero-count-visible-dispatch" }),
    ]);
  });
  it("drops repeated bot-pair turns before recording and releases prepared resources", async () => {
    const history = pendingHistory();
    const onDispatchSkipped = vi.fn();
    const turn = prepared({
      history,
      runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped },
      botLoopProtection: {
        scopeId: "prepared-loop-test",
        conversationId: "room",
        senderId: "bot-a",
        receiverId: "bot-b",
        config: { maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60 },
        defaultEnabled: true,
        nowMs: 1000,
      },
    });
    expect((await runPreparedChannelTurn(turn)).dispatched).toBe(true);
    expect(history.historyMap.get("room")).toStrictEqual([]);
    history.historyMap.set("room", [{ sender: "Alice", body: "queued again" }]);
    const result = await runAdapter({
      ingest,
      resolveTurn: () => ({
        ...turn,
        botLoopProtection: { ...turn.botLoopProtection, nowMs: 1001 },
      }),
    });
    expect(result).toMatchObject({
      admission: { kind: "drop", reason: "bot-loop-protection" },
      dispatched: false,
    });
    expect(turn.recordInboundSession).toHaveBeenCalledOnce();
    expect(turn.runDispatch).toHaveBeenCalledOnce();
    expect(onDispatchSkipped).toHaveBeenCalledWith("botLoopProtection");
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });

  it("drops a recorded webhook echo after thread unbind before record or dispatch", async () => {
    const history = pendingHistory();
    const recordInboundSession = createRecordInboundSession();
    const dispatch = createDispatch();
    const deliver = vi.fn();
    const onAdopted = vi.fn(async () => {});
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: "default",
      conversationId: "thread-1",
      sourceId: "webhook-1",
    });
    const result = await runAdapter({
      ingest,
      resolveTurn: () =>
        fixture.assembledTurn(storePath, {
          channel: "discord",
          accountId: "default",
          routeSessionKey: "agent:main:discord:channel:thread-1",
          ctxPayload: createCtx({
            Provider: "discord",
            Surface: "discord",
            ChatId: "thread-1",
            MessageSid: "webhook-message-1",
          }),
          outboundEchoSourceId: "webhook-1",
          recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher: dispatch,
          delivery: { deliver },
          turnAdoptionLifecycle: { onAdopted },
          history,
        }),
    });
    expect(result).toMatchObject({
      admission: { kind: "drop", reason: "outbound-echo" },
      dispatched: false,
    });
    expect(recordInboundSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(onAdopted).toHaveBeenCalledOnce();
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });

  it.each(["transcript", "record"])("cleans up after %s fails before dispatch", async (phase) => {
    const history = pendingHistory();
    const events: string[] = [];
    const error = new Error(`${phase} failed`);
    const afterRecord = vi.fn();
    const onPreDispatchFailure = vi.fn(async () => {
      events.push("cleanup");
    });
    const turn = prepared({
      history,
      afterRecord,
      onPreDispatchFailure,
      ctxPayload: createCtx({ AgentId: "main", SessionTranscriptContext: { historyLimit: 1 } }),
      recordInboundSession: vi.fn(async () => {
        events.push("record");
        throw error;
      }),
    });
    if (phase === "transcript") {
      readRecent.mockRejectedValueOnce(error);
    }
    await expect(runPreparedChannelTurn(turn)).rejects.toBe(error);
    expect(events).toEqual(phase === "record" ? ["record", "cleanup"] : ["cleanup"]);
    expect(turn.recordInboundSession).toHaveBeenCalledTimes(phase === "record" ? 1 : 0);
    expect(afterRecord).not.toHaveBeenCalled();
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(onPreDispatchFailure).toHaveBeenCalledWith(error);
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });

  it("handles non-turn event classes without resolving a turn", async () => {
    const resolveTurn = vi.fn();
    const result = await runAdapter({
      ingest,
      classify: () => ({ kind: "reaction", canStartAgentTurn: false }),
      resolveTurn,
    });
    expect(result).toEqual({
      admission: { kind: "handled", reason: "event:reaction" },
      dispatched: false,
    });
    expect(resolveTurn).not.toHaveBeenCalled();
  });

  it("records dropped history with local media through the turn kernel", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    const resolveTurn = vi.fn();
    const image = { path: "/tmp/a.png", contentType: "image/png", kind: "image" } as const;
    const result = await runAdapter({
      ingest: () => ({ id: "msg-1", timestamp: 1700000000000, rawText: "<media:image>" }),
      preflight: () => ({
        admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
        message: { bodyForAgent: "<media:image>", senderLabel: "Alice" },
        history: { key: "room-1", historyMap, limit: 5, mediaLimit: 2 },
        media: async () => [image, { ...image, path: "https://example.com/b.png" }],
      }),
      resolveTurn,
    });
    expect(result).toEqual({
      admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
      dispatched: false,
    });
    expect(resolveTurn).not.toHaveBeenCalled();
    expect(historyMap.get("room-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        timestamp: 1700000000000,
        messageId: "msg-1",
        media: [{ ...image, messageId: "msg-1" }],
      },
    ]);
  });

  it("runs observe-only turns through record, dispatch and finalize without visible delivery", async () => {
    const events: string[] = [];
    dispatchCore.mockImplementation(createDispatch(events));
    recordCore.mockImplementation(async () => {
      events.push("record");
    });
    const deliver = vi.fn();
    const onFinalize = vi.fn();
    const result = await runAdapter({
      ingest,
      preflight: () => ({ kind: "observeOnly", reason: "broadcast-observer" }),
      resolveTurn: () =>
        routed({
          route: {
            agentId: "observer",
            dmScope: "per-channel-peer",
            sessionKey: "agent:observer:test:peer",
          },
          ctxPayload: createCtx({ SessionKey: "agent:observer:test:peer" }),
          delivery: { deliver },
        }),
      onFinalize,
    });
    expectDispatched(result);
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(events).toEqual(["record", "dispatch"]);
    expect(dispatchCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ DmScope: "per-channel-peer" }),
        suppressOutboundHooks: true,
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(hasVisibleChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(resolveChannelTurnDispatchCounts(result.dispatchResult)).toEqual({
      tool: 0,
      block: 0,
      final: 0,
    });
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("degrades private admission evidence when routing changes the DM scope", async () => {
    const audit = createChannelAdmissionAudit({ enabled: true });
    try {
      const ctx = createCtx();
      bindTestChannelParticipantAdmissionEvidence({
        audit,
        context: ctx,
        channelId: "test",
        participantId: "person-1",
      });
      await runAdapter({
        ingest,
        resolveTurn: () =>
          routed({
            route: {
              agentId: "main",
              dmScope: "per-channel-peer",
              sessionKey: "agent:main:test:peer",
            },
            ctxPayload: ctx,
          }),
      });
      const dispatched = dispatchCore.mock.calls[0]?.[0];
      expect(dispatched?.ctx.DmScope).toBe("per-channel-peer");
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(dispatched?.ctx ?? {})),
      ).toMatchObject({ ingressState: "unknown", invoker: { state: "unknown" } });
    } finally {
      audit.close();
    }
  });

  it("clears history and finalizes failed dispatches before rethrowing", async () => {
    const history = pendingHistory();
    const onFinalize = vi.fn();
    const error = new Error("dispatch failed");
    dispatchCore.mockRejectedValueOnce(error);
    await expect(
      runAdapter({ ingest, resolveTurn: () => routed({ history }), onFinalize }),
    ).rejects.toBe(error);
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        admission: { kind: "dispatch" },
        dispatched: false,
        routeSessionKey: "agent:main:test:peer",
      }),
    );
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });
  it("finalizes unowned adoption when the prepared lifecycle is missing", async () => {
    const { turn, run, onFinalize, expectIdle } = createTurn();
    Object.defineProperty(turn, "runDispatchLifecycle", { value: undefined });
    await expect(run({ onAdopted: vi.fn(async () => undefined) })).rejects.toThrow(
      "prepared turns must declare runDispatchLifecycle",
    );
    expectIdle();
    expect(onFinalize.mock.calls[0]?.[0]).toMatchObject({
      admission: { kind: "dispatch" },
      dispatched: false,
    });
  });

  it.each(["record", "dispatch"])("checks authority before %s", async (boundary) => {
    const { turn, run } = createTurn();
    let current = boundary === "dispatch";
    const refusal = new Error("channel authority revoked");
    turn.assertAuthority = () => {
      if (!current) {
        throw refusal;
      }
    };
    turn.recordInboundSession = vi.fn(async () => {
      current = false;
    });

    await expect(run()).rejects.toBe(refusal);

    expect(turn.recordInboundSession).toHaveBeenCalledTimes(boundary === "record" ? 0 : 1);
    expect(turn.runDispatch).not.toHaveBeenCalled();
  });

  it("settles prepared resources when observe-only suppresses dispatch", async () => {
    const events: string[] = [];
    const onDispatchSkipped = vi.fn(async () => {
      events.push("cleanup");
    });
    const observed = { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    const { turn, run, onFinalize } = createTurn(
      {
        recordInboundSession: createRecordInboundSession(events),
        runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped },
        observeOnlyDispatchResult: observed,
      },
      true,
    );
    const result = await run();
    expectDispatched(result);
    expect(result.dispatchResult).toBe(observed);
    expect(result.admission).toEqual({ kind: "observeOnly", reason: "broadcast-observer" });
    expect(events).toEqual(["record", "cleanup"]);
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(onDispatchSkipped).toHaveBeenCalledWith("observeOnly");
    expect(hasFinalChannelTurnDispatch(result.dispatchResult)).toBe(false);
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(result);
  });

  it.for(["admitted", "failed", "account-stopped", "gateway-stopped"] as const)(
    "keeps replay behind its agent startup admission: %s",
    async (outcome, { signal }) => {
      await withOpenClawTestState({ label: "channel-turn-startup-admission" }, async (state) => {
        await withAgentDatabaseStartupAdmission(async (admission) => {
          const { env } = state;
          const inspections = {
            qa: createDeferredCore<Preflight>(),
            other: createDeferredCore<Preflight>(),
          };
          const ready = { incompatible: [], indeterminate: [] };
          const finishInspections = () =>
            Object.values(inspections).forEach((item) => item.resolve(ready));
          const refusals = admission.defer({
            env,
            inspections: Object.entries(inspections).map(([agentId, inspection]) => ({
              target: { agentId, path: openOpenClawAgentDatabase({ agentId, env }).path },
              result: inspection.promise,
            })),
            reason: "Gateway startup is preparing the agent",
          });
          recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
          const lifetime = admission.adopt();
          admission.activate({
            isCurrent: () => true,
            preparationReady: Promise.resolve(),
            openAgent: async () => {},
            migrateAgent: async () => {},
            publishAgent: async () => {},
          });
          const gateway = createTestGatewayScheduler(createGatewaySchedulerClock(0).clock);
          const { scheduler } = createPluginServiceScheduler(gateway);
          const preDispatchFailure = vi.fn();
          const log = vi.fn();
          const sessionKey = "agent:qa:qa-channel:direct:peer";
          const { turn: replay, expectIdle } = createTurn({
            routeSessionKey: sessionKey,
            storePath: state.statePath("agents", "qa", "sessions", "sessions.json"),
            ctxPayload: createCtx({ AgentId: "qa", SessionKey: sessionKey }),
            recordInboundSession: vi.fn(async () => assertAdmitted("qa", { env })),
            onPreDispatchFailure: preDispatchFailure,
            log,
          });
          const { recordInboundSession: record, runDispatch: dispatch } = replay;
          const turn = withPluginServiceScheduler(scheduler, () => runPreparedChannelTurn(replay));
          void turn.catch(() => {});
          try {
            expectIdle();
            expect(log).toHaveBeenCalledWith(
              expect.objectContaining({ reason: "agent-database-preparation-pending" }),
            );
            if (outcome === "admitted") {
              inspections.qa.resolve(ready);
              expect((await withinTest(turn, signal)).dispatched).toBe(true);
              expect(record).toHaveBeenCalledOnce();
              expect(dispatch).toHaveBeenCalledOnce();
              expect(readRefusal("other", { env })?.code).toBe("agent-database-inspection-pending");
            } else if (outcome === "failed") {
              inspections.qa.reject(new Error("inspection failed"));
              await expect(withinTest(turn, signal)).rejects.toThrow("inspection failed");
              expect(dispatch).not.toHaveBeenCalled();
              expect(preDispatchFailure).toHaveBeenCalledOnce();
            } else {
              const stopping = outcome === "account-stopped" ? scheduler.stop() : lifetime.stop();
              await expect(withinTest(turn, signal)).rejects.toBeInstanceOf(Error);
              expectIdle();
              expect(preDispatchFailure).toHaveBeenCalledOnce();
              finishInspections();
              await stopping;
            }
          } finally {
            finishInspections();
            await Promise.allSettled([turn, lifetime.stop(), scheduler.stop(), gateway.stop()]);
          }
        });
      });
    },
  );
});
