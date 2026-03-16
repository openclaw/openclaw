import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { buildPairingReply } from "./pairing-messages.js";

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

  describe("pairingMessage config overrides", () => {
    it("uses custom header when provided", () => {
      const text = buildPairingReply({
        channel: "imessage",
        idLine: "Your iMessage sender id: +15550001111",
        code: "ABC123",
        pairingMessage: { header: "Verification required." },
      });
      expect(text).toContain("Verification required.");
      expect(text).not.toContain("OpenClaw");
    });

    it("uses custom codeLabel when provided", () => {
      const text = buildPairingReply({
        channel: "imessage",
        idLine: "Your iMessage sender id: +15550001111",
        code: "ABC123",
        pairingMessage: { codeLabel: "Your code:" },
      });
      expect(text).toContain("Your code: ABC123");
      expect(text).not.toContain("Pairing code:");
    });

    it("suppresses CLI hint when showCliHint is false", () => {
      const text = buildPairingReply({
        channel: "imessage",
        idLine: "Your iMessage sender id: +15550001111",
        code: "ABC123",
        pairingMessage: { showCliHint: false },
      });
      expect(text).not.toContain("openclaw");
      expect(text).not.toContain("Ask the bot owner to approve with:");
      expect(text).toContain("ABC123");
    });

    it("omits default footer when CLI hint is suppressed without custom footer", () => {
      const text = buildPairingReply({
        channel: "telegram",
        idLine: "Your Telegram user id: 42",
        code: "XYZ123",
        pairingMessage: { showCliHint: false },
      });
      expect(text.split("\n")).not.toContain("Ask the bot owner to approve with:");
      expect(text).not.toMatch(/openclaw\s+pairing\s+approve/);
    });

    it("uses custom footer when provided", () => {
      const text = buildPairingReply({
        channel: "telegram",
        idLine: "Your Telegram user id: 42",
        code: "XYZ999",
        pairingMessage: { footer: "Share this code with your contact." },
      });
      expect(text).toContain("Share this code with your contact.");
      expect(text).not.toContain("bot owner");
    });

    it("applies senderIdLabel overrides centrally", () => {
      const text = buildPairingReply({
        channel: "imessage",
        idLine: "Your iMessage sender id: +15550001111",
        senderId: "+15550001111",
        code: "ABC123",
        pairingMessage: { senderIdLabel: "Contact ID:" },
      });
      expect(text).toContain("Contact ID: +15550001111");
      expect(text).not.toContain("Your iMessage sender id:");
    });

    it("allows empty senderIdLabel overrides without falling back to defaults", () => {
      const text = buildPairingReply({
        channel: "telegram",
        idLine: "Your Telegram user id: 42",
        senderId: "42",
        code: "XYZ123",
        pairingMessage: { senderIdLabel: "" },
      });
      expect(text.split("\n")).toContain("42");
      expect(text).not.toContain("Your Telegram user id:");
    });

    it("applies no changes when pairingMessage is undefined (backward compat)", () => {
      const text = buildPairingReply({
        channel: "imessage",
        idLine: "Your iMessage sender id: +15550001111",
        code: "ABC123",
      });
      expect(text).toContain("OpenClaw: access not configured.");
      expect(text).toContain("Pairing code: ABC123");
    });
  });
});
