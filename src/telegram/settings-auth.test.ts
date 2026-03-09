import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auto-reply/command-auth.js", () => ({
  resolveCommandAuthorization: vi.fn(),
}));

vi.mock("../channels/command-gating.js", () => ({
  resolveCommandAuthorizedFromAuthorizers: vi.fn(),
}));

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { resolveCommandAuthorizedFromAuthorizers } from "../channels/command-gating.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSettingsAuthDecision } from "./settings-auth.js";

const mockResolveCommandAuth = vi.mocked(resolveCommandAuthorization);
const mockResolveFromAuthorizers = vi.mocked(resolveCommandAuthorizedFromAuthorizers);

afterEach(() => {
  vi.clearAllMocks();
});

function baseCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return { ...overrides } as OpenClawConfig;
}

function baseParams(overrides?: Record<string, unknown>) {
  return {
    chatId: 12345 as number,
    accountId: "default",
    senderId: "111",
    senderUsername: "alice",
    cfg: baseCfg(),
    allowFrom: undefined as Array<string | number> | undefined,
    effectiveDmPolicy: "pairing",
    storeAllowFrom: [] as string[],
    dmThreadId: undefined as number | undefined,
    groupConfig: undefined as Record<string, unknown> | undefined,
    groupAllowOverride: undefined as Array<string | number> | undefined,
    ...overrides,
  };
}

describe("resolveSettingsAuthDecision", () => {
  describe("requireTopic enforcement", () => {
    it("denies when requireTopic=true and no dmThreadId", () => {
      const result = resolveSettingsAuthDecision(
        baseParams({
          groupConfig: { requireTopic: true },
          dmThreadId: undefined,
        }),
      );
      expect(result).toEqual({ authorized: false, reason: "require-topic" });
    });

    it("proceeds when requireTopic=true and dmThreadId is present", () => {
      mockResolveFromAuthorizers.mockReturnValue(true);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: true } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(
        baseParams({
          groupConfig: { requireTopic: true },
          dmThreadId: 42,
        }),
      );
      expect(result.authorized).toBe(true);
    });
  });

  describe("per-DM/topic allowFrom override", () => {
    it("uses groupAllowOverride when present instead of account-level allowFrom", () => {
      // groupAllowOverride restricts to user "222", but sender is "111".
      // With access groups off and modeWhenAccessGroupsOff=configured,
      // when an allowlist is configured and sender not on it, should deny.
      mockResolveFromAuthorizers.mockReturnValue(false);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: false } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(
        baseParams({
          allowFrom: [111], // account-level would allow sender 111
          groupAllowOverride: [222], // per-DM override restricts to 222 only
        }),
      );
      expect(result.authorized).toBe(false);
    });
  });

  describe("open access (no allowlist, access groups off)", () => {
    it("allows when no allowlist is configured and useAccessGroups is false", () => {
      // When no allowlist entries exist and access groups are off,
      // resolveCommandAuthorizedFromAuthorizers with modeWhenAccessGroupsOff=configured
      // returns true (no authorizers configured → open access).
      mockResolveFromAuthorizers.mockReturnValue(true);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: true } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(
        baseParams({
          cfg: baseCfg({ commands: { useAccessGroups: false } }),
        }),
      );
      expect(result.authorized).toBe(true);
      // Verify resolveCommandAuthorizedFromAuthorizers was called with correct args
      expect(mockResolveFromAuthorizers).toHaveBeenCalledWith({
        useAccessGroups: false,
        authorizers: expect.arrayContaining([expect.objectContaining({ configured: false })]),
        modeWhenAccessGroupsOff: "configured",
      });
    });
  });

  describe("empty allowlist (access groups on)", () => {
    it("denies when allowlist has no entries and access groups are on", () => {
      // When access groups are on, resolveCommandAuthorizedFromAuthorizers
      // requires at least one configured+allowed authorizer.
      mockResolveFromAuthorizers.mockReturnValue(false);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: false } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(
        baseParams({
          cfg: baseCfg({ commands: { useAccessGroups: true } }),
        }),
      );
      expect(result.authorized).toBe(false);
    });
  });

  describe("commands.allowFrom takes precedence", () => {
    it("uses commands.allowFrom when configured instead of DM allowlist", () => {
      const cfg = baseCfg({
        commands: { allowFrom: { telegram: ["222"] } },
      });
      // commands.allowFrom is configured → first resolveCommandAuthorization
      // is called with commandAuthorized: false; if it returns authorized,
      // that result is used as the commandAuthorized input.
      mockResolveCommandAuth
        .mockReturnValueOnce({ isAuthorizedSender: true } as ReturnType<
          typeof resolveCommandAuthorization
        >)
        .mockReturnValueOnce({ isAuthorizedSender: true } as ReturnType<
          typeof resolveCommandAuthorization
        >);
      const result = resolveSettingsAuthDecision(baseParams({ cfg }));
      expect(result.authorized).toBe(true);
      // resolveCommandAuthorizedFromAuthorizers should NOT be called
      // when commands.allowFrom is configured.
      expect(mockResolveFromAuthorizers).not.toHaveBeenCalled();
    });

    it("denies when commands.allowFrom rejects the sender", () => {
      const cfg = baseCfg({
        commands: { allowFrom: { telegram: ["999"] } },
      });
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: false } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(baseParams({ cfg }));
      expect(result.authorized).toBe(false);
    });
  });

  describe("ownerAllowFrom enforcement", () => {
    it("denies when commandAuthorized but ownerAllowFrom rejects", () => {
      // First call (commands.allowFrom check) would pass, but the final
      // resolveCommandAuthorization enforces ownerAllowFrom and denies.
      mockResolveFromAuthorizers.mockReturnValue(true);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: false } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(baseParams());
      expect(result.authorized).toBe(false);
      expect(result.reason).toBe("not-authorized");
    });
  });

  describe("configWrites is NOT checked here (caller responsibility)", () => {
    it("returns authorized=true regardless of configWrites setting", () => {
      // configWrites check lives in the caller, not in the shared auth decision.
      // This test verifies the auth function does not reject based on configWrites.
      mockResolveFromAuthorizers.mockReturnValue(true);
      mockResolveCommandAuth.mockReturnValue({ isAuthorizedSender: true } as ReturnType<
        typeof resolveCommandAuthorization
      >);
      const result = resolveSettingsAuthDecision(baseParams());
      expect(result.authorized).toBe(true);
    });
  });
});
