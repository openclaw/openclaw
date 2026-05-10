import { describe, expect, it } from "vitest";
import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  const pairingReplyCases = [
    { channel: "telegram", idLine: "Your Telegram user id: 42", code: "QRS678" },
    { channel: "discord", idLine: "Your Discord user id: 1", code: "ABC123" },
    { channel: "slack", idLine: "Your Slack user id: U1", code: "DEF456" },
    { channel: "signal", idLine: "Your Signal number: +15550001111", code: "GHI789" },
    { channel: "imessage", idLine: "Your iMessage sender id: +15550002222", code: "JKL012" },
    { channel: "whatsapp", idLine: "Your WhatsApp phone number: +15550003333", code: "MNO345" },
  ] as const;

  it.each(pairingReplyCases)("formats pairing reply for $channel", (testCase) => {
    const text = buildPairingReply(testCase);
    expect(text).toContain("🔗 Almost done!");
    expect(text).toContain(`To connect your ${testCase.channel} to this assistant:`);
    expect(text).toContain(testCase.code);
    expect(text).toContain("Baseer Burhan");
    expect(text).toContain("Pairing Code");
    // idLine is accepted as param but intentionally not shown in user-facing message
    expect(text).not.toContain(testCase.idLine);
    expect(text).not.toContain("openclaw pairing approve");
  });
});
