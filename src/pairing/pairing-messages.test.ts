import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply, buildAllowlistReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_PROFILE"]);
    process.env.OPENCLAW_PROFILE = "isolated";
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  const cases = [
    {
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    },
    {
      channel: "discord",
      idLine: "Your Discord user id: 1",
      code: "ABC123",
    },
    {
      channel: "slack",
      idLine: "Your Slack user id: U1",
      code: "DEF456",
    },
    {
      channel: "signal",
      idLine: "Your Signal number: +15550001111",
      code: "GHI789",
    },
    {
      channel: "imessage",
      idLine: "Your iMessage sender id: +15550002222",
      code: "JKL012",
    },
    {
      channel: "whatsapp",
      idLine: "Your WhatsApp phone number: +15550003333",
      code: "MNO345",
    },
  ] as const;

  for (const testCase of cases) {
    it(`formats pairing reply for ${testCase.channel}`, () => {
      const text = buildPairingReply(testCase);
      expect(text).toContain(testCase.idLine);
      expect(text).toContain(`Pairing code: ${testCase.code}`);
      // CLI commands should respect OPENCLAW_PROFILE when set (most tests run with isolated profile)
      const commandRe = new RegExp(
        `(?:openclaw|openclaw) --profile isolated pairing approve ${testCase.channel} ${testCase.code}`,
      );
      expect(text).toMatch(commandRe);
    });
  }

  it("includes widget URL when provided", () => {
    const text = buildPairingReply({
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
      widgetUrl: "https://app.agentglob.com/chat/mybot",
    });
    expect(text).toContain("https://app.agentglob.com/chat/mybot");
    expect(text).toContain("register at:");
  });

  it("omits widget section when widgetUrl is undefined", () => {
    const text = buildPairingReply({
      channel: "telegram",
      idLine: "Your Telegram user id: 42",
      code: "QRS678",
    });
    expect(text).not.toContain("register at:");
  });
});

describe("buildAllowlistReply", () => {
  it("includes widget URL and user ID", () => {
    const text = buildAllowlistReply({
      idLine: "Your Telegram user id: 42",
      widgetUrl: "https://app.agentglob.com/chat/mybot",
    });
    expect(text).toContain("requires registration");
    expect(text).toContain("https://app.agentglob.com/chat/mybot");
    expect(text).toContain("Your Telegram user id: 42");
  });

  it("returns fallback message when no widget URL", () => {
    const text = buildAllowlistReply({
      idLine: "Your Telegram user id: 42",
    });
    expect(text).toContain("requires registration");
    expect(text).toContain("Contact the bot owner");
  });
});
