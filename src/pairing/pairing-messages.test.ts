import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildPairingReply } from "./pairing-messages.js";

describe("buildPairingReply", () => {
  let previousProfile: string | undefined;

  beforeEach(() => {
    previousProfile = process.env.DNA_PROFILE;
    process.env.DNA_PROFILE = "isolated";
  });

  afterEach(() => {
    if (previousProfile === undefined) {
      delete process.env.DNA_PROFILE;
      return;
    }
    process.env.DNA_PROFILE = previousProfile;
  });

  const cases = [
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
      // CLI commands should respect DNA_PROFILE when set (most tests run with isolated profile)
      const commandRe = new RegExp(
        `(?:dna|dna) --profile isolated pairing approve ${testCase.channel} <code>`,
      );
      expect(text).toMatch(commandRe);
    });
  }
});
