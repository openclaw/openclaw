/**
 * Tests for message_sending hook wiring in the message-action-runner pipeline.
 *
 * Branch A (plugin-handled): hook runs before plugin dispatch.
 * Branch B2 (gateway): hook runs before gateway call.
 * Broadcast: cancelled sends produce ok:false, cancelled:true result entries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const runMessageSendingMock = vi.hoisted(() => vi.fn());
const hasHooksMock = vi.hoisted(() => vi.fn((name: string) => name === "message_sending"));
const getGlobalHookRunnerMock = vi.hoisted(() =>
  vi.fn(() => ({
    hasHooks: hasHooksMock,
    runMessageSending: runMessageSendingMock,
  })),
);

const dispatchChannelMessageActionMock = vi.hoisted(() => vi.fn());
const sendMessageMock = vi.hoisted(() => vi.fn());
const sendPollMock = vi.hoisted(() => vi.fn());
const resolveAgentScopedOutboundMediaAccessMock = vi.hoisted(() =>
  vi.fn(() => ({ localRoots: [], readFile: async () => Buffer.from("") })),
);
const appendAssistantMessageToSessionTranscriptMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, sessionFile: "x" })),
);

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../../channels/plugins/message-action-dispatch.js", () => ({
  dispatchChannelMessageAction: dispatchChannelMessageActionMock,
}));

vi.mock("./message.js", () => ({
  sendMessage: sendMessageMock,
  sendPoll: sendPollMock,
}));

vi.mock("../../media/read-capability.js", () => ({
  resolveAgentScopedOutboundMediaAccess: resolveAgentScopedOutboundMediaAccessMock,
}));

vi.mock("../../config/sessions.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
}));

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

type OutboundSendServiceModule = typeof import("./outbound-send-service.js");
let executeSendAction: OutboundSendServiceModule["executeSendAction"];

function makeCtx(overrides?: Record<string, unknown>) {
  return {
    cfg: {},
    channel: "demo-outbound" as const,
    params: { to: "channel:123", message: "hello world" },
    dryRun: false,
    ...overrides,
  };
}

function pluginResult(messageId: string) {
  return {
    ok: true,
    value: { messageId },
    continuePrompt: "",
    output: "",
    sessionId: "s1",
    model: "sonnet-4.6",
    usage: {},
  };
}

beforeEach(async () => {
  vi.resetModules();
  ({ executeSendAction } = await import("./outbound-send-service.js"));
  dispatchChannelMessageActionMock.mockClear();
  sendMessageMock.mockClear();
  runMessageSendingMock.mockClear();
  hasHooksMock.mockClear();
  appendAssistantMessageToSessionTranscriptMock.mockClear();
  resolveAgentScopedOutboundMediaAccessMock.mockClear();
  // Default: no-op hook (no cancel, no modification)
  runMessageSendingMock.mockResolvedValue(undefined);
  hasHooksMock.mockImplementation((name: string) => name === "message_sending");
});

// ---------------------------------------------------------------------------
// Branch A – plugin-handled sends
// ---------------------------------------------------------------------------

describe("Branch A: plugin-handled sends", () => {
  it("hook fires before plugin dispatch", async () => {
    dispatchChannelMessageActionMock.mockResolvedValue(pluginResult("msg-a"));

    await executeSendAction({ ctx: makeCtx(), to: "channel:123", message: "hello world" });

    expect(runMessageSendingMock).toHaveBeenCalledOnce();
    expect(runMessageSendingMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "channel:123", content: "hello world" }),
      expect.objectContaining({ channelId: "demo-outbound" }),
    );
    // Plugin dispatch still happened (hook did not cancel)
    expect(dispatchChannelMessageActionMock).toHaveBeenCalled();
  });

  it("cancel blocks plugin dispatch and returns cancelled:true", async () => {
    runMessageSendingMock.mockResolvedValue({ cancel: true });

    const result = await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "blocked",
    });

    expect(result.cancelled).toBe(true);
    expect(result.handledBy).toBe("core");
    expect(dispatchChannelMessageActionMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("content modification is passed to plugin dispatch via ctx.params.message", async () => {
    runMessageSendingMock.mockResolvedValue({ content: "modified text" });
    dispatchChannelMessageActionMock.mockResolvedValue(pluginResult("msg-a2"));

    const ctx = makeCtx();
    await executeSendAction({ ctx, to: "channel:123", message: "original" });

    // ctx.params.message updated with modified content
    expect(ctx.params.message).toBe("modified text");
    // Plugin was dispatched (not cancelled)
    expect(dispatchChannelMessageActionMock).toHaveBeenCalled();
  });

  it("hook-modified content is written to mirror transcript on plugin-handled path", async () => {
    runMessageSendingMock.mockResolvedValue({ content: "filtered text" });
    dispatchChannelMessageActionMock.mockResolvedValue(pluginResult("msg-a3"));

    await executeSendAction({
      ctx: makeCtx({
        mirror: {
          sessionKey: "agent:main:demo-outbound:channel:123",
          agentId: "agent-1",
        },
      }),
      to: "channel:123",
      message: "original",
    });

    expect(appendAssistantMessageToSessionTranscriptMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: "filtered text" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Branch B2 – gateway sends (via sendMessage mock)
// ---------------------------------------------------------------------------

describe("Branch B2: sendMessage not called when hook cancels", () => {
  it("cancel from hook prevents sendMessage call on core path", async () => {
    runMessageSendingMock.mockResolvedValue({ cancel: true });
    // No plugin handler
    dispatchChannelMessageActionMock.mockResolvedValue(null);

    const result = await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "gateway msg",
    });

    expect(result.cancelled).toBe(true);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("hook-modified content is forwarded to sendMessage", async () => {
    runMessageSendingMock.mockResolvedValue({ content: "rewritten" });
    dispatchChannelMessageActionMock.mockResolvedValue(null);
    sendMessageMock.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "gateway",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "original",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ content: "rewritten" }));
  });

  it("passes skipMessageSendingHook:true to sendMessage when hooks are registered (B1 double-fire prevention)", async () => {
    runMessageSendingMock.mockResolvedValue(undefined);
    dispatchChannelMessageActionMock.mockResolvedValue(null);
    sendMessageMock.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "hi",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ skipMessageSendingHook: true }),
    );
  });

  it("passes skipMessageSendingHook:false when no hooks registered", async () => {
    // Make hasHooks return false for message_sending
    hasHooksMock.mockReturnValue(false);
    dispatchChannelMessageActionMock.mockResolvedValue(null);
    sendMessageMock.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "hi",
    });

    expect(runMessageSendingMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({ skipMessageSendingHook: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// Broadcast cancel semantics (tested via message-action-runner types)
// ---------------------------------------------------------------------------

describe("Broadcast cancel semantics via executeSendAction result shape", () => {
  it("returns cancelled:true payload when hook cancels", async () => {
    runMessageSendingMock.mockResolvedValue({ cancel: true });

    const result = await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "broadcast-item",
    });

    // handleBroadcastAction checks result.cancelled to set ok:false
    expect(result.cancelled).toBe(true);
    expect(result.payload).toEqual({ cancelled: true });
    expect(result.handledBy).toBe("core");
  });

  it("does not set cancelled when hook passes through", async () => {
    runMessageSendingMock.mockResolvedValue(undefined);
    dispatchChannelMessageActionMock.mockResolvedValue(null);
    sendMessageMock.mockResolvedValue({
      channel: "demo-outbound",
      to: "channel:123",
      via: "direct",
      mediaUrl: null,
    });

    const result = await executeSendAction({
      ctx: makeCtx(),
      to: "channel:123",
      message: "ok item",
    });

    expect(result.cancelled).toBeUndefined();
    expect(result.handledBy).toBe("core");
  });
});
