import { describe, expect, it, vi } from "vitest";
import {
  commandSpy,
  getOnHandler,
  getChatSpy,
  sendChatActionSpy,
  sendMessageSpy,
} from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";

function getCommandHandler(command: string) {
  const normalized = command.toLowerCase();
  const calls = commandSpy.mock.calls.filter((args) => (args?.[0] as string) === normalized);
  const call = calls.at(-1);
  if (!call) {
    throw new Error(`Missing command handler for: ${command}`);
  }
  return call[1] as (ctx: Record<string, unknown>) => Promise<void>;
}

function makeDmNativeCtx(commandText: string, match?: string, messageId = 42) {
  return {
    message: {
      chat: { id: 1111, type: "private" },
      from: { id: 2222, username: "dm_user" },
      text: commandText,
      date: 1736380800,
      message_id: messageId,
    },
    match,
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

function makeGroupNativeCtx(commandText: string, match?: string) {
  return {
    message: {
      chat: { id: -1001234567890, type: "supergroup", title: "Forum Group", is_forum: true },
      from: { id: 2222, username: "group_user" },
      text: commandText,
      date: 1736380800,
      message_id: 42,
      message_thread_id: 102,
    },
    match,
    me: { username: "openclaw_bot" },
    getFile: async () => ({ download: async () => new Uint8Array() }),
  };
}

describe("telegram native commands: DM context binding intercept", () => {
  it("registers /set_context and /clear_context as native commands", async () => {
    createTelegramBot({ token: "tok" });

    const registered = commandSpy.mock.calls.map((call) => call[0]);
    expect(registered).toContain("set_context");
    expect(registered).toContain("clear_context");
    // /context already exists
    expect(registered).toContain("context");
  });

  it("DM unbound: /set_context enters binding logic (not 'No context bound')", async () => {
    createTelegramBot({ token: "tok" });

    sendMessageSpy.mockClear();
    getChatSpy.mockResolvedValue({ id: -100987 } as unknown as Record<string, unknown>);
    sendChatActionSpy.mockResolvedValue(undefined);

    const handler = getCommandHandler("set_context");
    await handler(makeDmNativeCtx("/set_context -100987 42", "-100987 42"));

    const last = sendMessageSpy.mock.calls.at(-1);
    expect(last?.[1]).toContain("Context bound:");
    expect(last?.[1]).not.toContain("No context bound");
  });

  it("DM: /context uses binding query (not context report)", async () => {
    createTelegramBot({ token: "tok" });

    // first bind
    const setHandler = getCommandHandler("set_context");
    await setHandler(makeDmNativeCtx("/set_context -100987 42", "-100987 42"));

    sendMessageSpy.mockClear();

    const ctxHandler = getCommandHandler("context");
    await ctxHandler(makeDmNativeCtx("/context", "", 43));

    expect(sendMessageSpy.mock.calls.length).toBeGreaterThan(0);
    const last = sendMessageSpy.mock.calls.at(-1);
    expect(String(last?.[1] ?? "")).toContain("Context bound:");
    expect(String(last?.[1] ?? "")).toContain("chat_id=");
    expect(String(last?.[1] ?? "")).toContain("topic_id=");
  });

  it("Group native /context keeps context-report semantics", async () => {
    createTelegramBot({ token: "tok" });

    sendMessageSpy.mockClear();

    const handler = getCommandHandler("context");
    // In groups, native /context should go through the normal reply pipeline (context report)
    await handler(makeGroupNativeCtx("/context", ""));

    const lastText = (sendMessageSpy.mock.calls.at(-1)?.[1] as string | undefined) ?? "";
    // Must NOT be the DM binding query response.
    expect(lastText).not.toContain("Context bound:");
  });
});
