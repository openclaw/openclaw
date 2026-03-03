import { describe, expect, it } from "vitest";
import {
  type PreflightErrorCode,
  PREFLIGHT_ERROR_CATALOG,
  runPreflightChecks,
} from "./preflight.js";

function makeAuthProfileStore(
  profiles: Record<
    string,
    {
      type: string;
      provider: string;
      key?: string;
      token?: string;
      access?: string;
      refresh?: string;
      expires?: number;
    }
  >,
  usageStats?: Record<
    string,
    { cooldownUntil?: number; disabledUntil?: number; disabledReason?: string }
  >,
) {
  return {
    version: 1,
    profiles: profiles as never,
    usageStats: usageStats as never,
  };
}

describe("preflight", () => {
  describe("PREFLIGHT_ERROR_CATALOG", () => {
    it("every entry has code, message, and playbook", () => {
      for (const [code, entry] of Object.entries(PREFLIGHT_ERROR_CATALOG)) {
        expect(entry.message).toBeTruthy();
        expect(entry.playbook).toBeTruthy();
        expect(entry.severity).toMatch(/^(pass|warn|fail)$/);
        expect(code).toBe(entry.code);
      }
    });
  });

  describe("runPreflightChecks", () => {
    it("returns pass when provider has valid api_key credential", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(true);
      expect(result.checks).toHaveLength(1);
      expect(result.checks[0].status).toBe("pass");
      expect(result.checks[0].code).toBe("PROVIDER_HEALTHY");
    });

    it("returns fail when provider has no credentials", () => {
      const store = makeAuthProfileStore({});
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      const fail = result.checks.find((c) => c.code === "NO_CREDENTIALS");
      expect(fail).toBeTruthy();
      expect(fail!.status).toBe("fail");
      expect(fail!.provider).toBe("anthropic");
      expect(fail!.playbook).toBeTruthy();
    });

    it("returns fail for expired token credential without refresh token", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "tok-expired",
          expires: Date.now() - 60_000,
        },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      const fail = result.checks.find((c) => c.code === "CREDENTIALS_EXPIRED");
      expect(fail).toBeTruthy();
      expect(fail!.status).toBe("fail");
    });

    it("returns warn for token expiring soon", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          token: "tok-expiring",
          expires: Date.now() + 30 * 60_000, // 30 minutes
        },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
        warnExpiryMs: 60 * 60_000, // 1 hour threshold
      });
      // Should still be ok=true since it's a warning
      expect(result.ok).toBe(true);
      const warn = result.checks.find((c) => c.code === "CREDENTIALS_EXPIRING");
      expect(warn).toBeTruthy();
      expect(warn!.status).toBe("warn");
    });

    it("returns pass for oauth credential with refresh token even if expired", () => {
      const store = makeAuthProfileStore({
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
          access: "expired-access",
          refresh: "valid-refresh",
          expires: Date.now() - 60_000,
        },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(true);
      expect(result.checks[0].status).toBe("pass");
    });

    it("returns fail for oauth credential without access or refresh", () => {
      const store = makeAuthProfileStore({
        "anthropic:oauth": {
          type: "oauth",
          provider: "anthropic",
        },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.code === "NO_CREDENTIALS")).toBeTruthy();
    });

    it("returns warn when all profiles are in cooldown", () => {
      const now = Date.now();
      const store = makeAuthProfileStore(
        {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        },
        {
          "anthropic:default": { cooldownUntil: now + 60_000 },
        },
      );
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      // Cooldown is transient - still ok but with warning
      expect(result.ok).toBe(true);
      const warn = result.checks.find((c) => c.code === "ALL_PROFILES_COOLDOWN");
      expect(warn).toBeTruthy();
      expect(warn!.status).toBe("warn");
    });

    it("returns fail when profile has auth_permanent disabled reason", () => {
      const now = Date.now();
      const store = makeAuthProfileStore(
        {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        },
        {
          "anthropic:default": {
            disabledUntil: now + 3_600_000,
            disabledReason: "auth_permanent",
          },
        },
      );
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      const fail = result.checks.find((c) => c.code === "AUTH_PERMANENT_FAILURE");
      expect(fail).toBeTruthy();
      expect(fail!.status).toBe("fail");
    });

    it("validates multiple providers independently", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        // openai has no credentials
      });
      const result = runPreflightChecks({
        providers: ["anthropic", "openai"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.filter((c) => c.status === "pass")).toHaveLength(1);
      expect(result.checks.filter((c) => c.status === "fail")).toHaveLength(1);
    });

    it("validates fallback chain credentials", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        // openai has no credentials
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
        fallbackModels: [
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          { provider: "openai", model: "gpt-4o" },
        ],
      });
      expect(result.ok).toBe(false);
      const fallbackFail = result.checks.find((c) => c.code === "FALLBACK_NO_CREDENTIALS");
      expect(fallbackFail).toBeTruthy();
      expect(fallbackFail!.status).toBe("fail");
      expect(fallbackFail!.provider).toBe("openai");
      expect(fallbackFail!.model).toBe("gpt-4o");
    });

    it("fallback chain passes when all have credentials", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        "openai:default": { type: "api_key", provider: "openai", key: "sk-openai-test" },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
        fallbackModels: [
          { provider: "anthropic", model: "claude-sonnet-4-6" },
          { provider: "openai", model: "gpt-4o" },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.checks.every((c) => c.status !== "fail")).toBe(true);
    });

    it("returns empty checks for empty providers list", () => {
      const store = makeAuthProfileStore({});
      const result = runPreflightChecks({
        providers: [],
        authStore: store,
      });
      expect(result.ok).toBe(true);
      expect(result.checks).toHaveLength(0);
    });

    it("includes timestamp in summary", () => {
      const before = Date.now();
      const store = makeAuthProfileStore({});
      const result = runPreflightChecks({
        providers: [],
        authStore: store,
      });
      expect(result.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.timestamp).toBeLessThanOrEqual(Date.now());
    });

    it("returns fail for api_key credential with empty key", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "" },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.code === "NO_CREDENTIALS")).toBeTruthy();
    });

    it("returns fail for token credential with empty token", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "token", provider: "anthropic", token: "" },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      expect(result.checks.find((c) => c.code === "NO_CREDENTIALS")).toBeTruthy();
    });

    it("billing disabled reason produces fail", () => {
      const now = Date.now();
      const store = makeAuthProfileStore(
        {
          "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
        },
        {
          "anthropic:default": {
            disabledUntil: now + 3_600_000,
            disabledReason: "billing",
          },
        },
      );
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
      });
      expect(result.ok).toBe(false);
      const fail = result.checks.find((c) => c.code === "AUTH_PERMANENT_FAILURE");
      expect(fail).toBeTruthy();
    });

    it("deduplicates fallback providers already in primary list", () => {
      const store = makeAuthProfileStore({
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "sk-ant-test" },
      });
      const result = runPreflightChecks({
        providers: ["anthropic"],
        authStore: store,
        fallbackModels: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
      });
      // No FALLBACK_NO_CREDENTIALS since anthropic already validated in primary
      expect(result.ok).toBe(true);
      expect(result.checks.find((c) => c.code === "FALLBACK_NO_CREDENTIALS")).toBeUndefined();
    });
  });

  describe("formatPreflightSummary", () => {
    // Import inline to keep test focused
    it("formats human-readable summary", async () => {
      const { formatPreflightSummary } = await import("./preflight.js");
      const summary = {
        ok: false,
        timestamp: Date.now(),
        checks: [
          {
            status: "pass" as const,
            provider: "anthropic",
            code: "PROVIDER_HEALTHY" as PreflightErrorCode,
            message: "anthropic: credentials valid",
            playbook: "No action needed",
          },
          {
            status: "fail" as const,
            provider: "openai",
            code: "NO_CREDENTIALS" as PreflightErrorCode,
            message: "openai: no credentials found",
            playbook: "Run `openclaw login openai` or set API key",
          },
        ],
      };
      const formatted = formatPreflightSummary(summary);
      expect(formatted).toContain("openai");
      expect(formatted).toContain("FAIL");
      expect(formatted).toContain("openclaw login");
    });
  });
});
