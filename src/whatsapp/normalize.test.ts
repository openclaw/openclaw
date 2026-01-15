import { describe, expect, it } from "vitest";

import { isWhatsAppGroupJid, isWhatsAppUserTarget, normalizeWhatsAppTarget } from "./normalize.js";

describe("normalizeWhatsAppTarget", () => {
  it("preserves group JIDs", () => {
    expect(normalizeWhatsAppTarget("[redacted-email]")).toBe("[redacted-email]");
    expect(normalizeWhatsAppTarget("[redacted-email]")).toBe("[redacted-email]");
    expect(normalizeWhatsAppTarget("whatsapp:[redacted-email]")).toBe(
      "[redacted-email]",
    );
    expect(normalizeWhatsAppTarget("whatsapp:group:[redacted-email]")).toBe(
      "[redacted-email]",
    );
    expect(normalizeWhatsAppTarget("group:[redacted-email]")).toBe(
      "[redacted-email]",
    );
    expect(normalizeWhatsAppTarget(" WhatsApp:Group:[redacted-email] ")).toBe(
      "[redacted-email]",
    );
  });

  it("normalizes direct JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("[redacted-email]")).toBe("+1555123");
  });

  it("normalizes user JIDs with device suffix to E.164", () => {
    // This is the bug fix: JIDs like "41796666864:[redacted-email]" should
    // normalize to "+41796666864", not "+417966668640" (extra digit from ":0")
    expect(normalizeWhatsAppTarget("41796666864:[redacted-email]")).toBe("+41796666864");
    expect(normalizeWhatsAppTarget("1234567890:[redacted-email]")).toBe("+1234567890");
    // Without device suffix still works
    expect(normalizeWhatsAppTarget("[redacted-email]")).toBe("+41796666864");
  });

  it("normalizes LID JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("123456789@lid")).toBe("+123456789");
    expect(normalizeWhatsAppTarget("123456789@LID")).toBe("+123456789");
  });

  it("rejects invalid targets", () => {
    expect(normalizeWhatsAppTarget("wat")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:")).toBeNull();
    expect(normalizeWhatsAppTarget("@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("whatsapp:group:@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("[redacted-email]")).toBeNull();
  });

  it("handles repeated prefixes", () => {
    expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1555")).toBe("+1555");
    expect(normalizeWhatsAppTarget("group:group:[redacted-email]")).toBe("[redacted-email]");
  });
});

describe("isWhatsAppUserTarget", () => {
  it("detects user JIDs with various formats", () => {
    expect(isWhatsAppUserTarget("41796666864:[redacted-email]")).toBe(true);
    expect(isWhatsAppUserTarget("[redacted-email]")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@lid")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@LID")).toBe(true);
    expect(isWhatsAppUserTarget("123@lid:0")).toBe(false);
    expect(isWhatsAppUserTarget("[redacted-email]")).toBe(false);
    expect(isWhatsAppUserTarget("[redacted-email]")).toBe(false);
    expect(isWhatsAppUserTarget("+1555123")).toBe(false);
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs with or without prefixes", () => {
    expect(isWhatsAppGroupJid("[redacted-email]")).toBe(true);
    expect(isWhatsAppGroupJid("[redacted-email]")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:[redacted-email]")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:group:[redacted-email]")).toBe(true);
    expect(isWhatsAppGroupJid("[redacted-email]")).toBe(false);
    expect(isWhatsAppGroupJid("@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("[redacted-email]")).toBe(false);
    expect(isWhatsAppGroupJid("+1555123")).toBe(false);
  });
});
