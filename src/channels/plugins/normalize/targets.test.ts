import { describe, expect, it } from "vitest";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./imessage.js";
import { looksLikeWhatsAppTargetId, normalizeWhatsAppMessagingTarget } from "./whatsapp.js";

describe("normalize target helpers", () => {
  describe("iMessage", () => {
    it("normalizes blank inputs to undefined", () => {
      expect(normalizeIMessageMessagingTarget("   ")).toBeUndefined();
    });

    it("detects common iMessage target forms", () => {
      expect(looksLikeIMessageTargetId("sms:+15555550123")).toBe(true);
      expect(looksLikeIMessageTargetId("chat_id:123")).toBe(true);
      expect(looksLikeIMessageTargetId("user@example.com")).toBe(true);
      expect(looksLikeIMessageTargetId("+15555550123")).toBe(true);
      expect(looksLikeIMessageTargetId("")).toBe(false);
    });
  });

  describe("WhatsApp", () => {
    it("normalizes blank inputs to undefined", () => {
      expect(normalizeWhatsAppMessagingTarget("   ")).toBeUndefined();
    });

    it("detects common WhatsApp target forms", () => {
      expect(looksLikeWhatsAppTargetId("whatsapp:+15555550123")).toBe(true);
      expect(looksLikeWhatsAppTargetId("15555550123@c.us")).toBe(true);
      expect(looksLikeWhatsAppTargetId("+15555550123")).toBe(true);
      expect(looksLikeWhatsAppTargetId("")).toBe(false);
    });
  });
});
