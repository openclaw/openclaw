import { describe, expect, it } from "vitest";
import {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  normalizeWhatsAppTarget,
} from "./whatsapp-targets.js";

describe("plugin-sdk whatsapp-targets", () => {
  it("normalizes user targets through the public facade", () => {
    expect(normalizeWhatsAppTarget("1555123@s.whatsapp.net")).toBe("+1555123");
    expect(normalizeWhatsAppTarget("whatsapp:+1555123")).toBe("+1555123");
  });

  it("preserves valid group JIDs through the public facade", () => {
    expect(isWhatsAppGroupJid("120363401234567890@g.us")).toBe(true);
    expect(normalizeWhatsAppTarget("120363401234567890@g.us")).toBe("120363401234567890@g.us");
  });

  it("detects WhatsApp user JIDs through the public facade", () => {
    expect(isWhatsAppUserTarget("41796666864:0@s.whatsapp.net")).toBe(true);
    expect(isWhatsAppUserTarget("123456789@lid")).toBe(true);
    expect(isWhatsAppUserTarget("123456789-987654321@g.us")).toBe(false);
  });
});
