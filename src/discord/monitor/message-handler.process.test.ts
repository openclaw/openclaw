import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const reactMessageDiscord = vi.fn(async () => {});
const removeReactionDiscord = vi.fn(async () => {});
const dispatchInboundMessage = vi.fn(async () => ({
  queuedFinal: false,
  counts: { final: 0, tool: 0, block: 0 },
}));
const recordInboundSession = vi.fn(async () => {});
const readSessionUpdatedAt = vi.fn(() => undefined);
const resolveStorePath = vi.fn(() => "/tmp/openclaw-discord-process-test-sessions.json");

vi.mock("../send.js", () => ({
  reactMessageDiscord: (...args: unknown[]) => reactMessageDiscord(...args),
  removeReactionDiscord: (...args: unknown[]) => removeReactionDiscord(...args),
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessage(...args),
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
  recordInboundSession: (...args: unknown[]) => recordInboundSession(...args),
}));

vi.mock("../../config/sessions.js", () => ({
  readSessionUpdatedAt: (...args: unknown[]) => readSessionUpdatedAt(...args),
  resolveStorePath: (...args: unknown[]) => resolveStorePath(...args),
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

const createBaseContext = createBaseDiscordMessageContext;

beforeEach(() => {
  vi.useRealTimers();
  reactMessageDiscord.mockClear();
  removeReactionDiscord.mockClear();
  dispatchInboundMessage.mockReset();
  recordInboundSession.mockReset();
  readSessionUpdatedAt.mockReset();
  resolveStorePath.mockReset();
  dispatchInboundMessage.mockResolvedValue({
    queuedFinal: false,
    counts: { final: 0, tool: 0, block: 0 },
  });
  recordInboundSession.mockResolvedValue(undefined);
  readSessionUpdatedAt.mockReturnValue(undefined);
  resolveStorePath.mockReturnValue("/tmp/openclaw-discord-process-test-sessions.json");
});

describe("processDiscordMessage ack reactions", () => {
  it("skips ack reactions for group-mentions when mentions are not required", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord).not.toHaveBeenCalled();
  });

  it("sends ack reactions for mention-gated guild messages when mentioned", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: true,
      effectiveWasMentioned: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(reactMessageDiscord.mock.calls[0]).toEqual(["c1", "m1", "👀", { rest: {} }]);
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

    expect(reactMessageDiscord.mock.calls[0]).toEqual([
      "fallback-channel",
      "m1",
      "👀",
      { rest: {} },
    ]);
  });

  it("debounces intermediate phase reactions and jumps to done for short runs", async () => {
    dispatchInboundMessage.mockImplementationOnce(
      async (params: {
        replyOptions?: {
          onReasoningStream?: () => Promise<void> | void;
          onToolStart?: (payload: { name?: string }) => Promise<void> | void;
        };
      }) => {
        await params.replyOptions?.onReasoningStream?.();
        await params.replyOptions?.onToolStart?.({ name: "exec" });
        return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
      },
    );

    const ctx = await createBaseContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    const emojis = reactMessageDiscord.mock.calls.map((call) => call[2]);
    expect(emojis).toContain("👀");
    expect(emojis).toContain("✅");
    expect(emojis).not.toContain("🧠");
    expect(emojis).not.toContain("💻");
  });

  it("shows stall emojis for long no-progress runs", async () => {
    vi.useFakeTimers();
    dispatchInboundMessage.mockImplementationOnce(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 31_000);
      });
      return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
    });

    const ctx = await createBaseContext();
    // oxlint-disable-next-line typescript/no-explicit-any
    const runPromise = processDiscordMessage(ctx as any);

    let settled = false;
    void runPromise.finally(() => {
      settled = true;
    });
    for (let i = 0; i < 120 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await runPromise;
    const emojis = reactMessageDiscord.mock.calls.map((call) => call[2]);
    expect(emojis).toContain("⏳");
    expect(emojis).toContain("⚠️");
    expect(emojis).toContain("✅");
  });
});
