/**
 * Integration test: verifies the full hook chain from deliverReplies() through
 * the real (unmocked) emitMessageSentHook helper down to the hook infrastructure.
 *
 * Unlike delivery.test.ts which mocks emitMessageSentHook to test channel
 * delivery logic, this test leaves the helper unmocked and instead mocks the
 * lowest-level sinks (getGlobalHookRunner, triggerInternalHook) to prove the
 * end-to-end wiring works.
 */
import type { Bot } from "grammy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./delivery.js";

// Mock the lowest-level hook sinks — NOT emitMessageSentHook itself.
const mockRunMessageSent = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockHasHooks = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockTriggerInternalHook = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockCreateInternalHookEvent = vi.hoisted(() =>
  vi.fn((type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
    type,
    action,
    sessionKey,
    context,
  })),
);

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: mockHasHooks,
    runMessageSent: mockRunMessageSent,
  }),
}));

vi.mock("../../hooks/internal-hooks.js", () => ({
  triggerInternalHook: (...args: unknown[]) => mockTriggerInternalHook(...args),
  createInternalHookEvent: (
    type: string,
    action: string,
    sessionKey: string,
    context: Record<string, unknown>,
  ) => mockCreateInternalHookEvent(type, action, sessionKey, context),
}));

// Mock grammy and media loader (same as delivery.test.ts — no real API calls).
vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

const loadWebMedia = vi.fn();
vi.mock("../../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

function createRuntime(): Pick<RuntimeEnv, "error" | "log" | "exit"> {
  return { error: vi.fn(), log: vi.fn(), exit: vi.fn() };
}

function createBot(api: Record<string, unknown> = {}): Bot {
  return { api } as unknown as Bot;
}

describe("Telegram delivery → hook infrastructure (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHasHooks.mockReturnValue(true);
  });

  it("fires plugin hook runner end-to-end on successful text delivery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 42, chat: { id: "100" } });

    await deliverReplies({
      replies: [{ text: "integration test" }],
      chatId: "100",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendMessage }),
      replyToMode: "off",
      textLimit: 4000,
      sessionKey: "agent:main:e2e",
      accountId: "acct-int",
    });

    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "100",
        content: expect.stringContaining("integration test"),
        success: true,
      }),
      expect.objectContaining({
        channelId: "telegram",
        accountId: "acct-int",
        conversationId: "100",
      }),
    );
  });

  it("fires internal hook end-to-end with sessionKey on successful delivery", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 55, chat: { id: "200" } });

    await deliverReplies({
      replies: [{ text: "hook chain test" }],
      chatId: "200",
      token: "tok",
      runtime: createRuntime() as RuntimeEnv,
      bot: createBot({ sendMessage }),
      replyToMode: "off",
      textLimit: 4000,
      sessionKey: "agent:main:sess",
      accountId: "acct-2",
    });

    expect(mockCreateInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:sess",
      expect.objectContaining({
        to: "200",
        content: expect.stringContaining("hook chain test"),
        success: true,
        channelId: "telegram",
        accountId: "acct-2",
        messageId: "55",
      }),
    );
    expect(mockTriggerInternalHook).toHaveBeenCalled();
  });

  it("fires both plugin and internal failure hooks end-to-end when send throws", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("API down"));

    await expect(
      deliverReplies({
        replies: [{ text: "will fail" }],
        chatId: "300",
        token: "tok",
        runtime: createRuntime() as RuntimeEnv,
        bot: createBot({ sendMessage }),
        replyToMode: "off",
        textLimit: 4000,
        sessionKey: "agent:main:fail",
        accountId: "acct-3",
      }),
    ).rejects.toThrow("API down");

    expect(mockRunMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "300",
        success: false,
        error: "API down",
      }),
      expect.objectContaining({ channelId: "telegram" }),
    );

    expect(mockCreateInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "agent:main:fail",
      expect.objectContaining({
        success: false,
        error: "API down",
      }),
    );
  });
});
