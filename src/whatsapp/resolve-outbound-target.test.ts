import { describe, it, expect, vi, beforeEach } from "vitest";
import * as normalize from "./normalize.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

vi.mock("./normalize.js");
vi.mock("../infra/outbound/target-errors.js", () => ({
  missingTargetError: (platform: string, format: string) => new Error(`${platform}: ${format}`),
}));

type ResolveParams = Parameters<typeof resolveWhatsAppOutboundTarget>[0];

function expectResolutionError(params: ResolveParams) {
  const result = resolveWhatsAppOutboundTarget(params);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolution to fail");
  }
  expect(result.error.message).toContain("WhatsApp");
}

function expectResolutionOk(params: ResolveParams, expectedTarget: string) {
  const result = resolveWhatsAppOutboundTarget(params);
  expect(result).toEqual({ ok: true, to: expectedTarget });
}

describe("resolveWhatsAppOutboundTarget", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("empty/missing to parameter", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
      ["whitespace only", "   "],
    ])("returns error when to is %s", (_label, to) => {
      expectResolutionError({ to, allowFrom: undefined, mode: undefined });
    });
  });

  describe("normalization failures", () => {
    it("returns error when normalizeWhatsAppTarget returns null/undefined", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce(null);
      expectResolutionError({
        to: "+1234567890",
        allowFrom: undefined,
        mode: undefined,
      });
    });
  });

  describe("group JID handling", () => {
    it("returns success for valid group JID regardless of mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363123456789@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      expectResolutionOk(
        {
          to: "120363123456789@g.us",
          allowFrom: undefined,
          mode: "implicit",
        },
        "120363123456789@g.us",
      );
    });

    it("returns success for group JID in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("120363999888777@g.us");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(true);

      expectResolutionOk(
        {
          to: "120363999888777@g.us",
          allowFrom: undefined,
          mode: "heartbeat",
        },
        "120363999888777@g.us",
      );
    });
  });

  describe("implicit/heartbeat mode with allowList", () => {
    it("allows message when wildcard is present", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: ["*"],
          mode: "implicit",
        },
        "+11234567890",
      );
    });

    it("allows message when allowList is empty", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: [],
          mode: "implicit",
        },
        "+11234567890",
      );
    });

    it("allows message when target is in allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: ["+11234567890"],
          mode: "implicit",
        },
        "+11234567890",
      );
    });

    it("denies message when target is not in allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+19876543210");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionError({
        to: "+11234567890",
        allowFrom: ["+19876543210"],
        mode: "implicit",
      });
    });

    it("handles mixed numeric and string allowList entries", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890") // for 'to' param
        .mockReturnValueOnce("+11234567890") // for allowFrom[0]
        .mockReturnValueOnce("+11234567890"); // for allowFrom[1]
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: [1234567890, "+11234567890"],
          mode: "implicit",
        },
        "+11234567890",
      );
    });

    it("filters out invalid normalized entries from allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce(null) // for allowFrom[0] "invalid" (processed first)
        .mockReturnValueOnce("+11234567890") // for allowFrom[1] "+11234567890"
        .mockReturnValueOnce("+11234567890"); // for 'to' param (processed last)
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: ["invalid", "+11234567890"],
          mode: "implicit",
        },
        "+11234567890",
      );
    });
  });

  describe("heartbeat mode", () => {
    it("allows message when target is in allowList in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: ["+11234567890"],
          mode: "heartbeat",
        },
        "+11234567890",
      );
    });

    it("denies message when target is not in allowList in heartbeat mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890")
        .mockReturnValueOnce("+19876543210");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionError({
        to: "+11234567890",
        allowFrom: ["+19876543210"],
        mode: "heartbeat",
      });
    });
  });

  describe("other modes (allow all valid targets)", () => {
    it("allows message in null mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: undefined,
          mode: null,
        },
        "+11234567890",
      );
    });

    it("allows message in undefined mode", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: undefined,
          mode: undefined,
        },
        "+11234567890",
      );
    });

    it("allows message in custom mode string", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+19876543210") // for allowFrom[0] (happens first!)
        .mockReturnValueOnce("+11234567890"); // for 'to' param (happens second)
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "+11234567890",
          allowFrom: ["+19876543210"],
          mode: "broadcast",
        },
        "+11234567890",
      );
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace from to parameter", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget).mockReturnValueOnce("+11234567890");
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectResolutionOk(
        {
          to: "  +11234567890  ",
          allowFrom: undefined,
          mode: undefined,
        },
        "+11234567890",
      );
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
