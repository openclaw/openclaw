import { describe, expect, it, vi } from "vitest";

import { monitorTelegramProvider } from "./monitor.js";

// Fake bot to capture handler and API calls
const handlers: Record<string, (ctx: any) => Promise<void> | void> = {};
const api = {
  sendMessage: vi.fn(),
  sendPhoto: vi.fn(),
  sendVideo: vi.fn(),
  sendAudio: vi.fn(),
  sendDocument: vi.fn(),
  setWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};

vi.mock("./bot.js", () => ({
  createTelegramBot: () => {
    handlers.message = async (ctx: any) => {
      const chatId = ctx.message.chat.id;
      const isGroup = ctx.message.chat.type !== "private";
      const text = ctx.message.text ?? ctx.message.caption ?? "";
      if (isGroup && !text.includes("@mybot")) return;
      if (!text.trim()) return;
      await api.sendMessage(chatId, `echo:${text}`, { parse_mode: "Markdown" });
    };
    return {
      on: vi.fn(),
      api,
      me: { username: "mybot" },
      stop: vi.fn(),
      start: vi.fn(),
    };
  },
  createTelegramWebhookCallback: vi.fn(),
}));

vi.mock("../auto-reply/reply.js", () => ({
  getReplyFromConfig: async (ctx: any) => ({ text: `echo:${ctx.Body}` }),
}));

describe("monitorTelegramProvider (grammY)", () => {
  it("processes a DM and sends reply", async () => {
    Object.values(api).forEach((fn) => fn?.mockReset?.());
    await monitorTelegramProvider({ token: "tok" });
    expect(handlers.message).toBeDefined();
    await handlers.message?.({
      message: {
        message_id: 1,
        chat: { id: 123, type: "private" },
        text: "hi",
      },
      me: { username: "mybot" },
      getFile: vi.fn(),
    });
    expect(api.sendMessage).toHaveBeenCalledWith(123, "echo:hi", {
      parse_mode: "Markdown",
    });
  });

  it("requires mention in groups by default", async () => {
    Object.values(api).forEach((fn) => fn?.mockReset?.());
    await monitorTelegramProvider({ token: "tok" });
    await handlers.message?.({
      message: {
        message_id: 2,
        chat: { id: -99, type: "supergroup", title: "G" },
        text: "hello all",
      },
      me: { username: "mybot" },
      getFile: vi.fn(),
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
