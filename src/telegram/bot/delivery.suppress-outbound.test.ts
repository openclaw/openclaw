import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverReplies } from "./delivery.js";

vi.mock("../../web/media.js", () => ({ loadWebMedia: vi.fn() }));
vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class extends Error {
    description = "";
  },
}));

describe("deliverReplies suppressOutbound", () => {
  it("blocks delivery when suppressOutbound is true", async () => {
    const sendMessage = vi.fn();
    const bot = { api: { sendMessage } } as unknown as Bot;
    const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

    const result = await deliverReplies({
      replies: [{ text: "Hello" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      cfg: { channels: { telegram: { suppressOutbound: true } } } as OpenClawConfig,
      accountId: "acct-1",
    });

    expect(result).toEqual({ delivered: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("allows delivery when suppressOutbound is false", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    const bot = { api: { sendMessage } } as unknown as Bot;
    const runtime = { error: vi.fn(), log: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;

    const result = await deliverReplies({
      replies: [{ text: "Hello" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      cfg: { channels: { telegram: {} } } as OpenClawConfig,
      accountId: "acct-1",
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(result).toEqual({ delivered: true });
  });
});
