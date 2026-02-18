import { describe, it, expect, vi, beforeEach } from "vitest";
import * as normalize from "./normalize.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

vi.mock("./normalize.js");
vi.mock("../infra/outbound/target-errors.js", () => ({
  missingTargetError: (platform: string, format: string) => new Error(`${platform}: ${format}`),
}));

describe("resolveWhatsAppOutboundTarget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("empty/missing to parameter", () => {
    it("returns error when to is null", () => {
      const result = resolveWhatsAppOutboundTarget({
        to: null,
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });

    it("returns error when to is undefined", () => {
      const result = resolveWhatsAppOutboundTarget({
        to: undefined,
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });

    it("returns error when to is empty string", () => {
      const result = resolveWhatsAppOutboundTarget({
        to: "",
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });

    it("returns error when to is whitespace only", () => {
      const result = resolveWhatsAppOutboundTarget({
        to: "   ",
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });
  });

  describe("normalization failures", () => {
    it("returns error when normalizeWhatsAppTarget returns null/undefined", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce(null);
      const result = resolveWhatsAppOutboundTarget({
        to: "+1234567890",
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });
  });

  describe("group JID handling", () => {
    it("returns success for valid group JID regardless of mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363123456789@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      const result = resolveWhatsAppOutboundTarget({
        to: "120363123456789@g.us",
        allowFrom: undefined,
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("120363123456789@g.us");
      }
    });

    it("returns success for group JID in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363999888777@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      const result = resolveWhatsAppOutboundTarget({
        to: "120363999888777@g.us",
        allowFrom: undefined,
        mode: "heartbeat",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("120363999888777@g.us");
      }
    });
  });

  describe("implicit/heartbeat mode with allowList", () => {
    it("allows message when wildcard is present", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["*"],
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("allows message when allowList is empty", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: [],
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("allows message when target is in allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["+11234567890"],
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("denies message when target is not in allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+19876543210");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["+19876543210"],
        mode: "implicit",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });

    it("handles mixed numeric and string allowList entries", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890") // for 'to' param
        .mockReturnValueOnce("+11234567890") // for allowFrom[0]
        .mockReturnValueOnce("+11234567890"); // for allowFrom[1]
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: [1234567890, "+11234567890"],
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("filters out invalid normalized entries from allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce(null) // for allowFrom[0] "invalid" (processed first)
        .mockReturnValueOnce("+11234567890") // for allowFrom[1] "+11234567890"
        .mockReturnValueOnce("+11234567890"); // for 'to' param (processed last)
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["invalid", "+11234567890"],
        mode: "implicit",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });
  });

  describe("heartbeat mode", () => {
    it("allows message when target is in allowList in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["+11234567890"],
        mode: "heartbeat",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("denies message when target is not in allowList in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+19876543210");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["+19876543210"],
        mode: "heartbeat",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("WhatsApp");
      }
    });
  });

  describe("other modes (allow all valid targets)", () => {
    it("allows message in null mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: undefined,
        mode: null,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("allows message in undefined mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });

    it("allows message in custom mode string", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+19876543210") // for allowFrom[0] (happens first!)
        .mockReturnValueOnce("+11234567890"); // for 'to' param (happens second)
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["+19876543210"],
        mode: "broadcast",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.to).toBe("+11234567890");
      }
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace from to parameter", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      const result = resolveWhatsAppOutboundTarget({
        to: "  +11234567890  ",
        allowFrom: undefined,
        mode: undefined,
      });
      expect(result.ok).toBe(true);
      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith("+11234567890");
    });

    it("trims whitespace from allowList entries", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      resolveWhatsAppOutboundTarget({
        to: "+11234567890",
        allowFrom: ["  +11234567890  "],
        mode: undefined,
      });

      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith("+11234567890");
    });
  });
});
