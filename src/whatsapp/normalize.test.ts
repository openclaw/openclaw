import { describe, expect, it } from "vitest";
import {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeBrazilPhone,
  normalizeWhatsAppTarget,
} from "./normalize.js";

describe("normalizeWhatsAppTarget", () => {
  it("preserves group JIDs", () => {
    expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe("120363401234567890@g.us");
    expect(normalizeWhatsAppTarget("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(normalizeWhatsAppTarget("whatsapp:120363401234567890@g.us")).toBe(
      "120363401234567890@g.us",
    );
  });

  it("normalizes direct JIDs to E.164", () => {
    expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
  });

  it("normalizes user JIDs with device suffix to E.164", () => {
    // This is the bug fix: JIDs like "41796666864:0@s.whatsapp.net" should
    // normalize to "+41796666864", not "+417966668640" (extra digit from ":0")
    expect(normalizeWhatsAppTarget("41796666864:0@s.whatsapp.net")).toBe("+41796666864");
    expect(normalizeWhatsAppTarget("1234567890:123@s.whatsapp.net")).toBe("+1234567890");
    // Without device suffix still works
    expect(normalizeWhatsAppTarget("41796666864@s.whatsapp.net")).toBe("+41796666864");
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
    expect(normalizeWhatsAppTarget("whatsapp:group:120363401234567890@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget("group:123456789-987654321@g.us")).toBeNull();
    expect(normalizeWhatsAppTarget(" WhatsApp:Group:123456789-987654321@G.US ")).toBeNull();
    expect(normalizeWhatsAppTarget("abc@s.whatsapp.net")).toBeNull();
  });

  it("handles repeated prefixes", () => {
    expect(normalizeWhatsAppTarget("whatsapp:whatsapp:+1555")).toBe("+1555");
    expect(normalizeWhatsAppTarget("group:group:120@g.us")).toBeNull();
  });
});

describe("isWhatsAppUserTarget", () => {
  it("detects user JIDs with various formats", () => {
    expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("1234567890@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@lid")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@LID")).toBe(true);
    expect(isWhatsAppUserTarget("123@lid:0")).toBe(false);
    expect(isWhatsAppUserTarget("abc@s.whatsapp.net")).toBe(false);
    expect(isWhatsAppUserTarget("123456789-987654321@g.us")).toBe(false);
    expect(isWhatsAppUserTarget("+1555123")).toBe(false);
  });
});

describe("isWhatsAppGroupJid", () => {
  it("detects group JIDs with or without prefixes", () => {
    expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("123456789-987654321@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:120363401234567890@g.us")).toBe(true);
    expect(isWhatsAppGroupJid("whatsapp:group:120363401234567890@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("x@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("@g.us")).toBe(false);
    expect(isWhatsAppGroupJid("120@g.usx")).toBe(false);
    expect(isWhatsAppGroupJid("+1555123")).toBe(false);
  });
});

describe("normalizeBrazilPhone", () => {
  it("removes 9th digit from Brazilian mobile numbers outside SP/RJ/ES (14 -> 13 digits)", () => {
    // Issue #20187: DDDs outside 11-19, 21-24, 27-28 should remove the 9th digit
    // DDD 47 (Santa Catarina) - remove 9
    expect(normalizeBrazilPhone("+5547984178525")).toBe("+554784178525");
    // DDD 81 (Pernambuco) - remove 9
    expect(normalizeBrazilPhone("+5581987654321")).toBe("+558187654321");
    // DDD 31 (Minas Gerais) - remove 9
    expect(normalizeBrazilPhone("+5531987654321")).toBe("+553187654321");
  });

  it("keeps 9th digit for São Paulo DDDs (11-19)", () => {
    // DDD 11 (São Paulo capital) - keep 9
    expect(normalizeBrazilPhone("+5511999998888")).toBe("+5511999998888");
    // DDD 12 (São Paulo interior) - keep 9
    expect(normalizeBrazilPhone("+5512987654321")).toBe("+5512987654321");
    // DDD 19 (São Paulo interior) - keep 9
    expect(normalizeBrazilPhone("+5519987654321")).toBe("+5519987654321");
  });

  it("keeps 9th digit for Rio de Janeiro DDDs (21, 22, 24)", () => {
    // DDD 21 (Rio capital) - keep 9
    expect(normalizeBrazilPhone("+5521987654321")).toBe("+5521987654321");
    // DDD 22 (Rio interior) - keep 9
    expect(normalizeBrazilPhone("+5522987654321")).toBe("+5522987654321");
    // DDD 24 (Rio interior) - keep 9
    expect(normalizeBrazilPhone("+5524987654321")).toBe("+5524987654321");
  });

  it("keeps 9th digit for Espírito Santo DDDs (27, 28)", () => {
    // DDD 27 - keep 9
    expect(normalizeBrazilPhone("+5527987654321")).toBe("+5527987654321");
    // DDD 28 - keep 9
    expect(normalizeBrazilPhone("+5528987654321")).toBe("+5528987654321");
  });

  it("leaves 13-digit Brazilian numbers unchanged", () => {
    // Already in WhatsApp format
    expect(normalizeBrazilPhone("+554784178525")).toBe("+554784178525");
    expect(normalizeBrazilPhone("+551199998888")).toBe("+551199998888");
  });

  it("leaves non-Brazilian numbers unchanged", () => {
    expect(normalizeBrazilPhone("+15551234567")).toBe("+15551234567");
    expect(normalizeBrazilPhone("+447123456789")).toBe("+447123456789");
    expect(normalizeBrazilPhone("+33612345678")).toBe("+33612345678");
  });

  it("leaves invalid Brazilian numbers unchanged", () => {
    // Too short or doesn't have 9 in the right position
    expect(normalizeBrazilPhone("+551234")).toBe("+551234");
    expect(normalizeBrazilPhone("+554798417852")).toBe("+554798417852"); // 13 digits
  });
});

describe("normalizeWhatsAppTarget - Brazilian numbers", () => {
  it("normalizes 14-digit Brazilian numbers to 13 digits (outside SP/RJ/ES)", () => {
    // Issue #20187: DDD 47 should have the 9th digit removed
    expect(normalizeWhatsAppTarget("+5547984178525")).toBe("+554784178525");
    expect(normalizeWhatsAppTarget("whatsapp:+5547984178525")).toBe("+554784178525");
  });

  it("preserves 9th digit for São Paulo numbers (DDD 11-19)", () => {
    // DDD 11 should keep the 9
    expect(normalizeWhatsAppTarget("+5511999998888")).toBe("+5511999998888");
    expect(normalizeWhatsAppTarget("whatsapp:+5511999998888")).toBe("+5511999998888");
  });

  it("preserves 13-digit Brazilian numbers", () => {
    // Already in WhatsApp format
    expect(normalizeWhatsAppTarget("+554784178525")).toBe("+554784178525");
  });
});
