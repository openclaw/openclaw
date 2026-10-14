// Covers gateway security audit aggregation.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";

function hasFinding(checkId: string, findings: ReturnType<typeof collectGatewayConfigFindings>) {
  return findings.some((finding) => finding.checkId === checkId);
}

function hasFindingWithSeverity(
  checkId: string,
  severity: "info" | "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

describe("security audit gateway config findings", () => {
  it("does not allow Tailscale auth outside loopback", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { allowTailscale: true },
        tailscale: { mode: "serve" },
      },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {});
    expect(hasFindingWithSeverity("gateway.bind_no_auth", "critical", findings)).toBe(true);
  });

  describe.each(["token", "password"] as const)("%s strength", (credential) => {
    it.each(["  "])('flags a stringified nullish gateway secret as critical: "%s"', (secret) => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { mode: credential, [credential]: secret },
        },
      };
      const findings = collectGatewayConfigFindings(cfg, cfg, {});
      expect(
        hasFindingWithSeverity(`gateway.${credential}_placeholder_value`, "critical", findings),
      ).toBe(true);
      // The placeholder finding replaces the misleading length-only warning.
      expect(hasFinding(`gateway.${credential}_too_short`, findings)).toBe(false);
    });
  });

  it("evaluates gateway auth presence and rate-limit guardrails", () => {
    const collect = (cfg: OpenClawConfig, sourceConfig = cfg) =>
      collectGatewayConfigFindings(cfg, sourceConfig, {});
    expect(
      hasFindingWithSeverity(
        "gateway.bind_no_auth",
        "critical",
        collect({ gateway: { bind: "lan", auth: {} } }),
      ),
    ).toBe(true);

    const passwordConfig: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: {
          password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
        },
      },
    };
    expect(hasFinding("gateway.bind_no_auth", collect(passwordConfig))).toBe(false);

    const sourceConfig: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } },
      },
      secrets: { providers: { default: { source: "env" } } },
    };
    const resolvedConfig: OpenClawConfig = {
      gateway: { bind: "lan", auth: {} },
      secrets: sourceConfig.secrets,
    };
    expect(hasFinding("gateway.bind_no_auth", collect(resolvedConfig, sourceConfig))).toBe(false);

    expect(
      hasFindingWithSeverity(
        "gateway.auth_no_rate_limit",
        "warn",
        collect({ gateway: { bind: "lan", auth: { token: "secret" } } }),
      ),
    ).toBe(true);
    const rateLimitedConfig: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: {
          token: "secret",
          rateLimit: { maxAttempts: 10, windowMs: 60_000, lockoutMs: 300_000 },
        },
      },
    };
    expect(hasFinding("gateway.auth_no_rate_limit", collect(rateLimitedConfig))).toBe(false);
  });

  it("warns when OPENCLAW_GATEWAY_TOKEN shadows a different configured token source", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { token: "config-token" } },
    };
    const findings = collectGatewayConfigFindings(cfg, cfg, {
      OPENCLAW_GATEWAY_TOKEN: "env-token",
    });

    expect(hasFinding("gateway.env_token_overrides_config", findings)).toBe(true);
  });
});
