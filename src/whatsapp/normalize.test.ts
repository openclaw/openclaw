import { describe, expect, it } from "vitest";

import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

describe("normalizeWhatsAppTarget", () => {
  it("preserves group JIDs", () => {
    expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
    expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(normalizeWhatsAppTarget("whatsapp:120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
    expect(
      normalizeWhatsAppTarget("whatsapp:group:120363401234567890@g.us"),
    ).toBe("120363401234567890@g.us");
    expect(normalizeWhatsAppTarget("group:123456789-987654321@g.us")).toBe(
      "123456789-987654321@g.us",
    );
    expect(
      normalizeWhatsAppTarget(" WhatsApp:Group:123456789-987654321@G.US "),
    ).toBe("123456789-987654321@g.us");
  });

  it("normalizes direct JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
  });

  it("rejects invalid targets", () => {
    expect(normalizeWhatsAppTarget("wat")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:")).toBeNull();
    expect(normalizeWhatsAppTarget("@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:group:@g.us")).toBeNull();
  });

  it("handles repeated prefixes", () => {
    expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1555")).toBe("+1555");
    expect(normalizeWhatsAppTarget("group:group:120@g.us")).toBe("120@g.us");
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs with or without prefixes", () => {
    expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:group:120363401234567890@g.us")).toBe(
      true,
    );
    expect(isWhatsAppGroupJid("x@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("120@g.usx")).toBe(false);
    expect(isWhatsAppGroupJid("+1555123")).toBe(false);
  });
});
