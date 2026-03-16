import { beforeEach, describe, expect, it } from "vitest";
import {
  getLoadConfigMock,
  getOnHandler,
  onSpy,
  replySpy,
} from "../../../../extensions/telegram/src/bot.create-telegram-bot.test-harness.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { expectChannelInboundContextContract } from "./suites.js";

const { createTelegramBot } = await import("../../../../extensions/telegram/src/bot.js");

describe("telegram inbound contract", () => {
  const loadConfig = getLoadConfigMock();

  beforeEach(() => {
    onSpy.mockClear();
    replySpy.mockClear();
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          envelopeTimezone: "utc",
        },
      },
      channels: {
        telegram: {
          groupPolicy: "open",
          groups: { "*": { requireMention: false } },
        },
      },
    } satisfies OpenClawConfig);
  });

  it("keeps inbound context finalized", async () => {
    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const payload = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
    expect(payload).toBeTruthy();
    expectChannelInboundContextContract(payload!);
  });
});
