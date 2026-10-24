import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";

function collect(cfg: OpenClawConfig, sourceConfig = cfg, env: NodeJS.ProcessEnv = {}) {
  return collectGatewayConfigFindings(cfg, sourceConfig, env);
}
function finding(checkId: string, severity?: string) {
  return expect.objectContaining(severity ? { checkId, severity } : { checkId });
}
function lan(auth: NonNullable<OpenClawConfig["gateway"]>["auth"]): OpenClawConfig {
  return { gateway: { bind: "lan", auth } };
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
    expect(collect(cfg)).toContainEqual(finding("gateway.bind_no_auth", "critical"));
  });

  describe.each(["token", "password"] as const)("%s strength", (credential) => {
    it.each(["  "])('flags a stringified nullish gateway secret as critical: "%s"', (secret) => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          auth: { mode: credential, [credential]: secret },
        },
      };
      const findings = collect(cfg);
      expect(findings).toContainEqual(
        finding(`gateway.${credential}_placeholder_value`, "critical"),
      );
      // The placeholder finding replaces the misleading length-only warning.
      expect(findings).not.toContainEqual(finding(`gateway.${credential}_too_short`));
    });
  });

  it("evaluates gateway auth presence and rate-limit guardrails", () => {
    const noAuth = finding("gateway.bind_no_auth");
    expect(collect({ gateway: { bind: "lan", auth: {} } })).toContainEqual(
      finding("gateway.bind_no_auth", "critical"),
    );

    const passwordConfig = lan({
      password: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_PASSWORD" },
    });
    expect(collect(passwordConfig)).not.toContainEqual(noAuth);

    const sourceConfig: OpenClawConfig = {
      ...lan({ token: { source: "env", provider: "default", id: "OPENCLAW_GATEWAY_TOKEN" } }),
      secrets: { providers: { default: { source: "env" } } },
    };
    const resolvedConfig: OpenClawConfig = {
      ...lan({}),
      secrets: sourceConfig.secrets,
    };
    expect(collect(resolvedConfig, sourceConfig)).not.toContainEqual(noAuth);

    expect(collect({ gateway: { bind: "lan", auth: { token: "secret" } } })).toContainEqual(
      finding("gateway.auth_no_rate_limit", "warn"),
    );
    const rateLimitedConfig = lan({
      token: "secret",
      rateLimit: { maxAttempts: 10, windowMs: 60_000, lockoutMs: 300_000 },
    });
    expect(collect(rateLimitedConfig)).not.toContainEqual(finding("gateway.auth_no_rate_limit"));
  });

  it("warns when OPENCLAW_GATEWAY_TOKEN shadows a different configured token source", () => {
    const cfg: OpenClawConfig = {
      gateway: { auth: { token: "config-token" } },
    };
    expect(collect(cfg, cfg, { OPENCLAW_GATEWAY_TOKEN: "env-token" })).toContainEqual(
      finding("gateway.env_token_overrides_config"),
    );
  });
});
