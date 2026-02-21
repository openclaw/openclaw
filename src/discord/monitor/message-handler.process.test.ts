import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";
import {
  __testing as threadBindingTesting,
  createThreadBindingManager,
} from "./thread-bindings.js";

const sendMocks = vi.hoisted(() => ({
  reactMessageDiscord: vi.fn(async () => {}),
  removeReactionDiscord: vi.fn(async () => {}),
}));
const deliveryMocks = vi.hoisted(() => ({
  editMessageDiscord: vi.fn(async () => ({})),
  deliverDiscordReply: vi.fn(async () => {}),
  createDiscordDraftStream: vi.fn(() => ({
    update: vi.fn<(text: string) => void>(() => {}),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => "preview-1"),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(() => {}),
  })),
}));
const editMessageDiscord = deliveryMocks.editMessageDiscord;
const deliverDiscordReply = deliveryMocks.deliverDiscordReply;
const createDiscordDraftStream = deliveryMocks.createDiscordDraftStream;
const reactMessageDiscord = sendMocks.reactMessageDiscord;
const removeReactionDiscord = sendMocks.removeReactionDiscord;
type DispatchInboundParams = {
  replyOptions?: {
    onReasoningStream?: () => Promise<void> | void;
    onToolStart?: (payload: { name?: string }) => Promise<void> | void;
    onFollowupQueued?: (payload: {
      runId: string;
      status: "queued" | "skipped" | "dropped" | "merged" | "failed";
      reason: string;
    }) => Promise<void> | void;
  };
};
const dispatchInboundMessage = vi.fn(async (_params?: DispatchInboundParams) => ({
  queuedFinal: true,
  counts: { final: 1, tool: 0, block: 0 },
}));
const recordInboundSession = vi.fn(async () => {});
const loadSessionStore = vi.fn(() => ({}));
const readSessionUpdatedAt = vi.fn(() => undefined);
const resolveStorePath = vi.fn(() => "/tmp/openclaw-discord-process-test-sessions.json");
const isEmbeddedPiRunActive = vi.fn(() => false);
const resolveEmbeddedSessionLane = vi.fn((key: string) => key);
const getQueueSize = vi.fn(() => 0);
const clearCommandLane = vi.fn(() => 0);
let agentEventListener:
  | ((evt: {
      runId: string;
      seq: number;
      stream: string;
      ts: number;
      sessionKey?: string;
      data: Record<string, unknown>;
    }) => void)
  | null = null;
const onAgentEvent = vi.fn((listener: typeof agentEventListener) => {
  agentEventListener = listener;
  return () => {
    if (agentEventListener === listener) {
      agentEventListener = null;
    }
  };
});

vi.mock("../send.js", () => ({
  reactMessageDiscord: sendMocks.reactMessageDiscord,
  removeReactionDiscord: sendMocks.removeReactionDiscord,
}));

vi.mock("../send.messages.js", () => ({
  editMessageDiscord: deliveryMocks.editMessageDiscord,
}));

vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream: deliveryMocks.createDiscordDraftStream,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverDiscordReply: deliveryMocks.deliverDiscordReply,
}));
vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage,
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

vi.mock("../../channels/session.js", () => ({
  recordInboundSession,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore,
  readSessionUpdatedAt,
  resolveStorePath,
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  isEmbeddedPiRunActive,
  resolveEmbeddedSessionLane,
}));

vi.mock("../../process/command-queue.js", () => ({
  getQueueSize,
  clearCommandLane,
}));

vi.mock("../../infra/agent-events.js", () => ({
  onAgentEvent,
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

const createBaseContext = createBaseDiscordMessageContext;

beforeEach(() => {
  vi.useRealTimers();
  sendMocks.reactMessageDiscord.mockClear();
  sendMocks.removeReactionDiscord.mockClear();
  editMessageDiscord.mockClear();
  deliverDiscordReply.mockClear();
  createDiscordDraftStream.mockClear();
  dispatchInboundMessage.mockReset();
  recordInboundSession.mockReset();
  loadSessionStore.mockReset();
  readSessionUpdatedAt.mockReset();
  resolveStorePath.mockReset();
  isEmbeddedPiRunActive.mockReset();
  resolveEmbeddedSessionLane.mockReset();
  getQueueSize.mockReset();
  clearCommandLane.mockReset();
  onAgentEvent.mockClear();
  dispatchInboundMessage.mockResolvedValue({
    queuedFinal: true,
    counts: { final: 1, tool: 0, block: 0 },
  });
  recordInboundSession.mockResolvedValue(undefined);
  loadSessionStore.mockReturnValue({});
  readSessionUpdatedAt.mockReturnValue(undefined);
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
  threadBindingTesting.resetThreadBindingsForTests();
  isEmbeddedPiRunActive.mockReturnValue(false);
  resolveEmbeddedSessionLane.mockImplementation((key: string) => key);
  getQueueSize.mockReturnValue(0);
  clearCommandLane.mockReturnValue(0);
});

function getLastRouteUpdate():
  | { sessionKey?: string; channel?: string; to?: string; accountId?: string }
  | undefined {
  const callArgs = recordInboundSession.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        updateLastRoute?: {
          sessionKey?: string;
          channel?: string;
          to?: string;
          accountId?: string;
        };
      }
    | undefined;
  return params?.updateLastRoute;
}

function getLastDispatchCtx():
  | { SessionKey?: string; MessageThreadId?: string | number }
  | undefined {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | { ctx?: { SessionKey?: string; MessageThreadId?: string | number } }
    | undefined;
  return params?.ctx;
}

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord.mock.calls[0]).toEqual(["c1", "m1", "👀", { rest: {} }]);
  });

  it("uses preflight-resolved messageChannelId when message.channelId is missing", async () => {
    const ctx = await createBaseContext({
      message: {
        id: "m1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "fallback-channel",
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(sendMocks.reactMessageDiscord.mock.calls[0]).toEqual([
      "fallback-channel",
      "m1",
      "👀",
      { rest: {} },
    ]);
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("👀");
    expect(emojis).toContain("✅");
    expect(emojis).not.toContain("🤔");
    expect(emojis).not.toContain("💻");
  });

  it("rate-limits rapid phase flips and suppresses transient tool emoji", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await vi.advanceTimersByTimeAsync(151);
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      await vi.advanceTimersByTimeAsync(100);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);
    await runPromise;

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("👀");
    expect(emojis).toContain("🤔");
    expect(emojis).not.toContain("💻");
    expect(emojis).toContain("✅");
  });

  it("quickly replaces previous emoji within 250ms during active transitions", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await vi.advanceTimersByTimeAsync(200);
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      await vi.advanceTimersByTimeAsync(200);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const reacted = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);

    expect(reacted[0]).toBe("⏳");
    expect(reacted).toContain("🤔");
    expect(reacted).toContain("💻");
    expect(removed).toContain("⏳");
    expect(removed).toContain("🤔");
  });

  it("blocks active-to-waiting regression when queued signal arrives after tool start", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      await vi.advanceTimersByTimeAsync(151);
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-active-then-queued",
        status: "queued",
        reason: "late-queued-signal",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("💻");
    expect(emojis).not.toContain("⏳");
    expect(emojis.at(-1)).toBe("💻");
  });

  it("prevents observed ⏳ -> 💻 -> ⏳ regression when queued arrives after active tool phase", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      await vi.advanceTimersByTimeAsync(151);
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-hourglass-regression",
        status: "queued",
        reason: "late-queued-signal",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis[0]).toBe("⏳");
    expect(emojis).toContain("💻");
    expect(emojis.filter((emoji) => emoji === "⏳")).toHaveLength(1);
    expect(emojis.at(-1)).toBe("💻");
  });

  it("retains waiting hourglass for queued/deferred runs instead of clearing immediately", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-q1",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(200);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("⏳");
    expect(emojis).not.toContain("👀");
    expect(emojis).not.toContain("✅");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).not.toContain("⏳");
  });

  it("promotes waiting hourglass to thinking when execution starts", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await vi.advanceTimersByTimeAsync(151);
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis[0]).toBe("⏳");
    expect(emojis).toContain("🤔");
    expect(emojis).toContain("✅");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("keeps waiting hourglass until execution starts (no timeout auto-clear)", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-q2",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(30_000);

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).not.toContain("⏳");
  });

  it("terminates waiting without done when queue outcome is skipped", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-skip",
        status: "skipped",
        reason: "dedupe",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(5);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).not.toContain("✅");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("terminates waiting without done when queue outcome is dropped", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-drop",
        status: "dropped",
        reason: "queue-cap-overflow-new",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(5);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).not.toContain("✅");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("terminates waiting on pre-start-fail without marking done", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-prestart",
        status: "queued",
        reason: "enqueued",
      });
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-prestart",
        status: "failed",
        reason: "pre-start-fail:no api key",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(5);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).not.toContain("✅");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("shows waiting hourglass for any message entering a busy session lane", async () => {
    getQueueSize.mockReturnValueOnce(2);
    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis[0]).toBe("⏳");
    expect(emojis).not.toContain("👀");
  });

  it("promotes queued waiting message from hourglass when session lifecycle starts", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-b",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    expect(agentEventListener).toBeTypeOf("function");

    agentEventListener?.({
      runId: "run-b",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "start" },
    });
    await vi.advanceTimersByTimeAsync(151);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("⏳");
    expect(emojis).toContain("🤔");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("recovers deferred status after error->retry->success lifecycle on same runId", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-retry",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: false },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    expect(agentEventListener).toBeTypeOf("function");

    agentEventListener?.({
      runId: "run-retry",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "error", error: "first attempt failed" },
    });

    agentEventListener?.({
      runId: "run-retry",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "start" },
    });
    await vi.advanceTimersByTimeAsync(151);

    agentEventListener?.({
      runId: "run-retry",
      seq: 3,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "end" },
    });
    await vi.advanceTimersByTimeAsync(5);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("❌");
    expect(emojis).toContain("🤔");
    expect(emojis).toContain("✅");
  });

  it("cleans deferred error mapping after retry TTL when no retry arrives", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-error-timeout",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: false },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    expect(agentEventListener).toBeTypeOf("function");

    agentEventListener?.({
      runId: "run-error-timeout",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "error", error: "first attempt failed" },
    });
    await vi.advanceTimersByTimeAsync(60_000);

    const reactedBeforeLateRetry = reactMessageDiscord.mock.calls.length;

    agentEventListener?.({
      runId: "run-error-timeout",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "start" },
    });
    await vi.advanceTimersByTimeAsync(151);

    expect(reactMessageDiscord.mock.calls).toHaveLength(reactedBeforeLateRetry);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("❌");
    expect(emojis).not.toContain("🤔");
  });

  it("does not regress back to hourglass when deferred lifecycle starts before dispatch settles", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-race",
        status: "queued",
        reason: "enqueued",
      });
      agentEventListener?.({
        runId: "run-race",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        sessionKey: "agent:main:discord:guild:g1",
        data: { phase: "start" },
      });
      await vi.advanceTimersByTimeAsync(151);
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("🤔");
    expect(emojis.at(-1)).toBe("🤔");

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("⏳");
  });

  it("keeps ack-only behavior in statusReactionMode=off even when reasoning/tools stream", async () => {
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onReasoningStream?.();
      await params?.replyOptions?.onToolStart?.({ name: "exec" });
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: false,
          statusReactionMode: "off",
        },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toEqual(["👀"]);
  });

  it("keeps ack-only behavior in statusReactionMode=off during long runs (no ⏳/⚠️)", async () => {
    vi.useFakeTimers();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = () => resolve();
    });
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await dispatchGate;
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: false,
          statusReactionMode: "off",
        },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(30_001);
    releaseDispatch();
    await vi.runAllTimersAsync();
    await runPromise;

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toEqual(["👀"]);
  });

  it("clears ack in statusReactionMode=off when removeAckAfterReply is enabled", async () => {
    vi.useFakeTimers();
    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
          statusReactionMode: "off",
        },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);
    await runPromise;
    await vi.advanceTimersByTimeAsync(1_600);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toEqual(["👀"]);

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("👀");
  });

  it("clears ack in statusReactionMode=off when queue outcome is non-queued", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-off-nonqueued",
        status: "dropped",
        reason: "queue-cap-overflow-new",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
          statusReactionMode: "off",
        },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(5);

    const emojis = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toEqual(["👀"]);

    const removed = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removed).toContain("👀");
  });

  it("keeps ack in statusReactionMode=off for queued/deferred runs until lifecycle end", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      await params?.replyOptions?.onFollowupQueued?.({
        runId: "run-off-deferred",
        status: "queued",
        reason: "enqueued",
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: {
          ackReaction: "👀",
          removeAckAfterReply: true,
          statusReactionMode: "off",
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);
    await vi.advanceTimersByTimeAsync(3_000);

    const emojisBeforeLifecycleEnd = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojisBeforeLifecycleEnd).toEqual(["👀"]);

    const removedBeforeLifecycleEnd = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removedBeforeLifecycleEnd).not.toContain("👀");

    expect(agentEventListener).toBeTypeOf("function");
    agentEventListener?.({
      runId: "run-off-deferred",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "start" },
    });
    await vi.advanceTimersByTimeAsync(151);

    const emojisAfterStart = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojisAfterStart).toEqual(["👀"]);

    agentEventListener?.({
      runId: "run-off-deferred",
      seq: 2,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "end" },
    });
    await vi.advanceTimersByTimeAsync(1_600);

    const removedAfterLifecycleEnd = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removedAfterLifecycleEnd).toContain("👀");
  });

  it("cleans deferred waiting when clearSessionQueues cancels queued run before lifecycle start", async () => {
    vi.useFakeTimers();
    isEmbeddedPiRunActive.mockReturnValue(true);
    loadSessionStore.mockReturnValueOnce({
      "agent:main:discord:guild:g1": { sessionId: "sess1" },
    });
    const { enqueueFollowupRun, clearSessionQueues } =
      await import("../../auto-reply/reply/queue.js");
    dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
      enqueueFollowupRun(
        "agent:main:discord:guild:g1",
        {
          prompt: "queued message",
          enqueuedAt: Date.now(),
          onQueueOutcome: params?.replyOptions?.onFollowupQueued,
          run: {
            runId: "run-cleared-before-start",
            agentId: "main",
            agentDir: "/tmp",
            sessionId: "sess-clear",
            sessionKey: "agent:main:discord:guild:g1",
            sessionFile: "/tmp/session-clear.json",
            workspaceDir: "/tmp",
            config: {} as never,
            provider: "mock",
            model: "mock-model",
            timeoutMs: 10_000,
            blockReplyBreak: "text_end",
          },
        } as never,
        { mode: "followup", debounceMs: 0, cap: 20, dropPolicy: "summarize" },
      );
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext({
      cfg: {
        messages: { ackReaction: "👀", removeAckAfterReply: true },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojisBeforeClear = (
      reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojisBeforeClear).toContain("⏳");

    clearSessionQueues(["agent:main:discord:guild:g1"]);
    await vi.advanceTimersByTimeAsync(5);

    const removedAfterClear = (
      removeReactionDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(removedAfterClear).toContain("⏳");

    const reactedBeforeLateStart = reactMessageDiscord.mock.calls.length;
    agentEventListener?.({
      runId: "run-cleared-before-start",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      sessionKey: "agent:main:discord:guild:g1",
      data: { phase: "start" },
    });
    await vi.advanceTimersByTimeAsync(151);

    expect(reactMessageDiscord.mock.calls).toHaveLength(reactedBeforeLateStart);
  });

  it("keeps waiting hourglass without warning for long no-progress queued runs", async () => {
    vi.useFakeTimers();
    let releaseDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      releaseDispatch = () => resolve();
    });
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await dispatchGate;
      return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);

    await vi.advanceTimersByTimeAsync(30_001);
    releaseDispatch();
    await vi.runAllTimersAsync();

    await runPromise;
    const emojis = (
      sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
    ).map((call) => call[2]);
    expect(emojis).toContain("⏳");
    expect(emojis).not.toContain("⚠️");
    expect(emojis).toContain("✅");
  });
});

describe("processDiscordMessage session routing", () => {
  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      data: { guild: null },
      channelInfo: null,
      channelName: undefined,
      isGuildMessage: false,
      isDirectMessage: true,
      isGroupDm: false,
      shouldRequireMention: false,
      canDetectMention: false,
      effectiveWasMentioned: false,
      displayChannelSlug: "",
      guildInfo: null,
      guildSlug: "",
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
      baseSessionKey: "agent:main:discord:direct:u1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:direct:u1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
  });

  it("stores group lastRoute with channel target", async () => {
    const ctx = await createBaseContext({
      baseSessionKey: "agent:main:discord:channel:c1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:channel:c1",
      channel: "discord",
      to: "channel:c1",
      accountId: "default",
    });
  });

  it("prefers bound session keys and sets MessageThreadId for bound thread messages", async () => {
    const threadBindings = createThreadBindingManager({
      accountId: "default",
      persist: false,
      enableSweeper: false,
    });
    await threadBindings.bindTarget({
      threadId: "thread-1",
      channelId: "c-parent",
      targetKind: "subagent",
      targetSessionKey: "agent:main:subagent:child",
      agentId: "main",
      webhookId: "wh_1",
      webhookToken: "tok_1",
      introText: "",
    });

    const ctx = await createBaseContext({
      messageChannelId: "thread-1",
      threadChannel: { id: "thread-1", name: "subagent-thread" },
      boundSessionKey: "agent:main:subagent:child",
      threadBindings,
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(getLastDispatchCtx()).toMatchObject({
      SessionKey: "agent:main:subagent:child",
      MessageThreadId: "thread-1",
    });
    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:subagent:child",
      channel: "discord",
      to: "channel:thread-1",
      accountId: "default",
    });
  });
});
