import type { Message } from "@grammyjs/types";
import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { NormalizedAllowFrom } from "./bot-access.js";
import { enforceTelegramDmAccess } from "./dm-access.js";

const upsertMock = vi.hoisted(() => vi.fn().mockResolvedValue({ created: true, code: "ABCD" }));
const buildPairingReplyMock = vi.hoisted(() => vi.fn().mockReturnValue("pairing reply text"));

vi.mock("../pairing/pairing-store.js", () => ({
  upsertChannelPairingRequest: (...args: unknown[]) => upsertMock(...args),
}));
vi.mock("../pairing/pairing-messages.js", () => ({
  buildPairingReply: (...args: unknown[]) => buildPairingReplyMock(...args),
}));
vi.mock("./api-logging.js", () => ({
  withTelegramApiErrorLogging: async (opts: { fn: () => Promise<unknown> }) => opts.fn(),
}));

const msg = {
  chat: { id: 123, type: "private" },
  from: { id: 42, is_bot: false, first_name: "Alice" },
} as unknown as Message;

const effectiveDmAllow: NormalizedAllowFrom = {
  entries: ["+15550009999"],
  hasWildcard: false,
  hasEntries: true,
  invalidEntries: [],
};

describe("enforceTelegramDmAccess suppressOutbound", () => {
  it("records pairing request and blocks reply when suppressed", async () => {
    const sendMessage = vi.fn();
    const bot = { api: { sendMessage } } as unknown as Bot;

    const result = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg,
      chatId: 123,
      effectiveDmAllow,
      accountId: "acct-1",
      bot,
      logger: { info: vi.fn() },
      cfg: { channels: { telegram: { suppressOutbound: true } } } as OpenClawConfig,
    });

    expect(upsertMock).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("records pairing request and sends reply when not suppressed", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
    const bot = { api: { sendMessage } } as unknown as Bot;

    const result = await enforceTelegramDmAccess({
      isGroup: false,
      dmPolicy: "pairing",
      msg,
      chatId: 123,
      effectiveDmAllow,
      accountId: "acct-1",
      bot,
      logger: { info: vi.fn() },
      cfg: { channels: { telegram: {} } } as OpenClawConfig,
    });

    expect(upsertMock).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
    expect(result).toBe(false);
  });
});
