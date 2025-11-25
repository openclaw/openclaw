import { describe, expect, it } from "vitest";
import { assertProvider, normalizeE164, toWhatsappJid } from "./index.js";

describe("normalizeE164", () => {
  it("strips whatsapp prefix and whitespace", () => {
    expect(normalizeE164("whatsapp:+1 555 123 4567")).toBe("+15551234567");
  });

  it("adds plus when missing", () => {
    expect(normalizeE164("1555123")).toBe("+1555123");
  });
});

describe("toWhatsappJid", () => {
  it("converts E164 to jid", () => {
    expect(toWhatsappJid("+1 555 123 4567")).toBe("[redacted-email]");
  });
});

describe("assertProvider", () => {
  it("accepts valid providers", () => {
    expect(() => assertProvider("twilio")).not.toThrow();
    expect(() => assertProvider("web")).not.toThrow();
  });

  it("throws on invalid provider", () => {
    expect(() => assertProvider("invalid" as string)).toThrow();
  });
});
