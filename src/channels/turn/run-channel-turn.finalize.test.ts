// Preserve mock setup before modules that consume it.
// oxfmt-ignore
import { channelTurnMocks } from "./run-channel-turn.test-support.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindTestChannelParticipantAdmissionEvidence } from "../../../test/helpers/channel-admission-evidence.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { HistoryEntry } from "../../auto-reply/reply/history.types.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import {
  createChannelAdmissionAudit,
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
} from "../message-access/admission-evidence.js";
import { outboundMessageIdentities } from "../message/outbound-echo-state.js";
import { recordOutboundMessageIdentity } from "../message/outbound-echo.js";
import {
  hasVisibleChannelTurnDispatchFromReceipt,
  resolveChannelTurnDispatchCounts,
} from "./dispatch-result.js";
import { runPreparedChannelTurn } from "./execution.js";
import {
  createCtx,
  createDispatch,
  createRecordInboundSession,
  expectDispatched,
} from "./run-channel-turn.delivery.test-helpers.js";
import { runChannelTurn } from "./run-channel-turn.js";
import type {
  ChannelTurnHistoryFinalizeOptions,
  ChannelTurnPlan,
  PreparedChannelTurn,
  RunChannelTurnParams,
} from "./types.js";

const {
  recordInboundSessionCore,
  dispatchReplyWithRoutedChannelDispatcherCore,
  emitMessageSent,
  getGlobalHookRunner,
  createMessageSentEmitter,
  readRecentUserAssistantTextForSession,
} = channelTurnMocks;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let storePath: string;

function pendingHistory() {
  const historyMap = new Map<string, HistoryEntry[]>([
    ["room", [{ sender: "Alice", body: "earlier message" }]],
  ]);
  return {
    isGroup: true,
    historyKey: "room",
    historyMap,
    limit: 50,
  } satisfies ChannelTurnHistoryFinalizeOptions;
}
function prepared<T extends Partial<PreparedChannelTurn>>(overrides: T) {
  return {
    channel: "test",
    routeSessionKey: "agent:main:test:peer",
    storePath,
    ctxPayload: createCtx(),
    recordInboundSession: createRecordInboundSession(),
    runDispatch: vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    })),
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
function run(adapter: RunChannelTurnParams<unknown>["adapter"]) {
  return runChannelTurn({ channel: "test", raw: {}, adapter });
}
const ingest = () => ({ id: "msg-1", rawText: "hello" });

describe("channel turn finalize", () => {
  beforeEach(() => {
    storePath = path.join(tempDirs.make("openclaw-channel-turn-finalize-"), "sessions.json");
    vi.clearAllMocks();
    recordInboundSessionCore.mockResolvedValue(undefined);
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch());
    outboundMessageIdentities.clear();
    resetDiagnosticEventsForTest();
    resetLogger();
    setLoggerOverride({ level: "info" });
    createMessageSentEmitter.mockImplementation(() => ({
      emitMessageSent,
      hasMessageSentHooks: true,
    }));
    getGlobalHookRunner.mockReturnValue(null);
    readRecentUserAssistantTextForSession.mockResolvedValue([]);
  });
  afterEach(() => {
    setLoggerOverride(null);
    resetLogger();
  });

  it("drops a multi-party bot burst that stays under every pair budget", async () => {
    const onDispatchSkipped = vi.fn();
    const runDispatch = vi.fn(async () => ({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    }));
    const runTurn = (senderId: string, nowMs: number) =>
      runPreparedChannelTurn(
        prepared({
          routeSessionKey: "agent:main:test:burst",
          runDispatch,
          runDispatchLifecycle: { turnAdoptionLifecycle: undefined, onDispatchSkipped },
          messageId: `msg-${senderId}-${nowMs}`,
          botLoopProtection: {
            scopeId: "burst-loop-test",
            conversationId: "burst-room",
            senderId,
            receiverId: "self",
            // Pair budget stays permissive so only the conversation burst trips.
            config: {
              maxEventsPerWindow: 100,
              windowSeconds: 60,
              cooldownSeconds: 60,
              maxConversationBotEvents: 2,
            },
            defaultEnabled: true,
            nowMs,
          },
        }),
      );

    // Two peer senders alternate; the burst trips once both are actively
    // posting (2+ events each in the window) and the total exceeds the limit.
    for (let index = 0; index < 3; index += 1) {
      const turn = await runTurn(`bot-${index % 2}`, 1_000 + index * 1_000);
      expect(turn.dispatched).toBe(true);
    }
    const tripped = await runTurn("bot-1", 5_000);
    expect(tripped).toMatchObject({
      admission: { kind: "drop", reason: "bot-loop-protection" },
      dispatched: false,
    });
    expect(onDispatchSkipped).toHaveBeenCalledWith("botLoopProtection");
    expect(runDispatch).toHaveBeenCalledTimes(3);
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
    const result = await run({
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
    const result = await run({
      ingest,
      resolveTurn: () => ({
        cfg: {},
        channel: "discord",
        accountId: "default",
        agentId: "main",
        storePath,
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

  it("clears history when transcript-context merge fails before recording", async () => {
    const history = pendingHistory();
    const error = new Error("transcript read failed");
    const turn = prepared({
      history,
      ctxPayload: createCtx({ AgentId: "main", SessionTranscriptContext: { historyLimit: 1 } }),
    });
    readRecentUserAssistantTextForSession.mockRejectedValueOnce(error);
    await expect(runPreparedChannelTurn(turn)).rejects.toBe(error);
    expect(turn.recordInboundSession).not.toHaveBeenCalled();
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });

  it("cleans up pre-created dispatchers and history when session recording fails", async () => {
    const history = pendingHistory();
    const events: string[] = [];
    const error = new Error("session store failed");
    const afterRecord = vi.fn();
    const onPreDispatchFailure = vi.fn(async () => {
      events.push("cleanup");
    });
    const turn = prepared({
      history,
      afterRecord,
      onPreDispatchFailure,
      recordInboundSession: vi.fn(async () => {
        events.push("record");
        throw error;
      }),
    });
    await expect(runPreparedChannelTurn(turn)).rejects.toBe(error);
    expect(events).toEqual(["record", "cleanup"]);
    expect(afterRecord).not.toHaveBeenCalled();
    expect(turn.runDispatch).not.toHaveBeenCalled();
    expect(onPreDispatchFailure).toHaveBeenCalledWith(error);
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });

  it("handles non-turn event classes without resolving a turn", async () => {
    const resolveTurn = vi.fn();
    const result = await run({
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
    const result = await run({
      ingest: () => ({ id: "msg-1", timestamp: 1700000000000, rawText: "<media:image>" }),
      preflight: () => ({
        admission: { kind: "drop", reason: "missing-mention", recordHistory: true },
        message: { bodyForAgent: "<media:image>", senderLabel: "Alice" },
        history: { key: "room-1", historyMap, limit: 5, mediaLimit: 2 },
        media: async () => [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image" },
          { path: "https://example.com/b.png", contentType: "image/png", kind: "image" },
        ],
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
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });

  it("runs observe-only turns through record, dispatch and finalize without visible delivery", async () => {
    const events: string[] = [];
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementation(createDispatch(events));
    recordInboundSessionCore.mockImplementation(async () => {
      events.push("record");
    });
    const deliver = vi.fn();
    const onFinalize = vi.fn();
    const result = await run({
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
    expect(dispatchReplyWithRoutedChannelDispatcherCore).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({ DmScope: "per-channel-peer" }),
        suppressOutboundHooks: true,
      }),
    );
    expect(deliver).not.toHaveBeenCalled();
    expect(hasVisibleChannelTurnDispatchFromReceipt(result.dispatchResult)).toBe(false);
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
      await run({
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
      const dispatched = dispatchReplyWithRoutedChannelDispatcherCore.mock.calls[0]?.[0];
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
    dispatchReplyWithRoutedChannelDispatcherCore.mockRejectedValueOnce(error);
    await expect(run({ ingest, resolveTurn: () => routed({ history }), onFinalize })).rejects.toBe(
      error,
    );
    expect(onFinalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        admission: { kind: "dispatch" },
        dispatched: false,
        routeSessionKey: "agent:main:test:peer",
      }),
    );
    expect(history.historyMap.get("room")).toStrictEqual([]);
  });
});
