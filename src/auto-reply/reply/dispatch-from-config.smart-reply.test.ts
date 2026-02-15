import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn(async () => ({
    handled: false,
    aborted: false,
  })),
}));
const diagnosticMocks = vi.hoisted(() => ({
  logMessageQueued: vi.fn(),
  logMessageProcessed: vi.fn(),
  logSessionStateChange: vi.fn(),
}));
const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageReceived: vi.fn(async () => {}),
  },
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: () => {
    return "⚙️ Agent was aborted.";
  },
}));

vi.mock("../../logging/diagnostic.js", () => ({
  logMessageQueued: diagnosticMocks.logMessageQueued,
  logMessageProcessed: diagnosticMocks.logMessageProcessed,
  logSessionStateChange: diagnosticMocks.logSessionStateChange,
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
  };
}

describe("dispatchReplyFromConfig Smart Reply Suppression", () => {
  beforeEach(() => {
    resetInboundDedupe();
    diagnosticMocks.logMessageProcessed.mockReset();
  });

  it("suppresses [NO_REPLY] response", async () => {
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      SessionKey: "test:session",
    });

    const replyResolver = async () => ({ text: "[NO_REPLY]" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "smart-reply-suppressed",
      }),
    );
  });

  it("suppresses [no_reply] response (case insensitive)", async () => {
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      SessionKey: "test:session",
    });

    const replyResolver = async () => ({ text: "[no_reply]" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "smart-reply-suppressed",
      }),
    );
  });

  it("suppresses [NO_REPLY]. response (with dot)", async () => {
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      SessionKey: "test:session",
    });

    const replyResolver = async () => ({ text: "[NO_REPLY]." }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(diagnosticMocks.logMessageProcessed).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "skipped",
        reason: "smart-reply-suppressed",
      }),
    );
  });

  it("does not suppress normal response", async () => {
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      SessionKey: "test:session",
    });

    const replyResolver = async () => ({ text: "Hello world" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "Hello world" });
  });

  it("does not suppress partial match like 'I said [NO_REPLY]'", async () => {
    const cfg = { diagnostics: { enabled: true } } as OpenClawConfig;
    const dispatcher = createDispatcher();
    const ctx = buildTestCtx({
      Provider: "telegram",
      ChatType: "group",
      SessionKey: "test:session",
    });

    const replyResolver = async () =>
      ({ text: "I said [NO_REPLY] to him." }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).toHaveBeenCalled();
  });
});
