import { describe, it, expect, vi, beforeEach } from "vitest";
import * as normalize from "./normalize.js";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

vi.mock("./normalize.js");
vi.mock("../infra/outbound/target-errors.js", () => ({
  missingTargetError: (platform: string, format: string) => new Error(`${platform}: ${format}`),
}));

type ResolveParams = Parameters<typeof resolveWhatsAppOutboundTarget>[0];
const PRIMARY_TARGET = "+11234567890";
const SECONDARY_TARGET = "+19876543210";

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

function mockNormalizedDirectMessage(...values: Array<string | null>) {
  const normalizeMock = vi.mocked(normalize.normalizeWhatsAppTarget);
  for (const value of values) {
    normalizeMock.mockReturnValueOnce(value);
  }
  vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);
}

function expectAllowedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
}) {
  const to = params.to ?? PRIMARY_TARGET;
  expectResolutionOk(
    {
      to,
      allowFrom: params.allowFrom,
      mode: params.mode,
    },
    to,
  );
}

function expectDeniedForTarget(params: {
  allowFrom: ResolveParams["allowFrom"];
  mode: ResolveParams["mode"];
  to?: string;
}) {
  const result = resolveWhatsAppOutboundTarget({
    to: params.to ?? PRIMARY_TARGET,
    allowFrom: params.allowFrom,
    mode: params.mode,
  });
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected resolution to fail");
  }
  expect(result.error).toBeInstanceOf(Error);
  return result.error;
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
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: ["*"], mode: "implicit" });
    });

    it("allows message when allowList is empty", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [], mode: "implicit" });
    });

    it("allows message when target is in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "implicit" });
    });

    it("denies message when target is not in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET);
      const error = expectDeniedForTarget({
        allowFrom: [SECONDARY_TARGET],
        mode: "implicit",
      });
      expect(error.message).toBe(
        'Target "+19876543210" is not listed in the configured WhatsApp allowFrom policy.',
      );
    });

    it("handles mixed numeric and string allowList entries", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce("+11234567890") // for 'to' param
        .mockReturnValueOnce("+11234567890") // for allowFrom[0]
        .mockReturnValueOnce("+11234567890"); // for allowFrom[1]
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectAllowedForTarget({
        allowFrom: [1234567890, PRIMARY_TARGET],
        mode: "implicit",
      });
    });

    it("filters out invalid normalized entries from allowList", () => {
      vi.mocked(normalize.normalizeWhatsAppTarget)
        .mockReturnValueOnce(null) // for allowFrom[0] "invalid" (processed first)
        .mockReturnValueOnce("+11234567890") // for allowFrom[1] "+11234567890"
        .mockReturnValueOnce("+11234567890"); // for 'to' param (processed last)
      vi.mocked(normalize.isWhatsAppGroupJid).mockReturnValueOnce(false);

      expectAllowedForTarget({
        allowFrom: ["invalid", PRIMARY_TARGET],
        mode: "implicit",
      });
    });
  });

  describe("heartbeat mode", () => {
    it("allows message when target is in allowList in heartbeat mode", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "heartbeat" });
    });

    it("denies message when target is not in allowList in heartbeat mode", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, SECONDARY_TARGET);
      const error = expectDeniedForTarget({
        allowFrom: [SECONDARY_TARGET],
        mode: "heartbeat",
      });
      expect(error.message).toBe(
        'Target "+19876543210" is not listed in the configured WhatsApp allowFrom policy.',
      );
    });
  });

  describe("explicit/custom modes", () => {
    it("allows message in null mode when allowList is not set", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: undefined, mode: null });
    });

    it("allows message in undefined mode when allowList is not set", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: undefined, mode: undefined });
    });

    it("enforces allowList in custom mode string", () => {
      mockNormalizedDirectMessage(SECONDARY_TARGET, PRIMARY_TARGET);
      const error = expectDeniedForTarget({
        allowFrom: [SECONDARY_TARGET],
        mode: "broadcast",
      });
      expect(error.message).toBe(
        'Target "+11234567890" is not listed in the configured WhatsApp allowFrom policy.',
      );
    });

    it("allows message in custom mode string when target is in allowList", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);
      expectAllowedForTarget({ allowFrom: [PRIMARY_TARGET], mode: "broadcast" });
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace from to parameter", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET);

      expectResolutionOk(
        {
          to: `  ${PRIMARY_TARGET}  `,
          allowFrom: undefined,
          mode: undefined,
        },
        PRIMARY_TARGET,
      );
      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith(PRIMARY_TARGET);
    });

    it("trims whitespace from allowList entries", () => {
      mockNormalizedDirectMessage(PRIMARY_TARGET, PRIMARY_TARGET);

      resolveWhatsAppOutboundTarget({
        to: PRIMARY_TARGET,
        allowFrom: [`  ${PRIMARY_TARGET}  `],
        mode: undefined,
      });

      expect(vi.mocked(normalize.normalizeWhatsAppTarget)).toHaveBeenCalledWith(PRIMARY_TARGET);
    });
  });
});
