import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectHooksHardeningFindings } from "./audit-extra.sync.js";
import { runSecurityAuditCore } from "./audit.js";

function hasFinding(
  findings: ReturnType<typeof collectHooksHardeningFindings>,
  checkId: string,
  severity: "warn" | "critical",
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function getFinding(findings: ReturnType<typeof collectHooksHardeningFindings>, checkId: string) {
  return findings.find((finding) => finding.checkId === checkId);
}

type AuditOptions = Parameters<typeof runSecurityAuditCore>[0];
const hookToken = "shared-gateway-token-1234567890";
const baseHooks = { enabled: true, token: hookToken, defaultSessionKey: "hook:ingress" };
function auditSecretReuse(
  auth: NonNullable<OpenClawConfig["gateway"]>["auth"],
  token: string,
  options: Partial<AuditOptions> = {},
  providers: NonNullable<OpenClawConfig["secrets"]>["providers"] = { default: { source: "env" } },
) {
  return runSecurityAuditCore({
    config: {
      agents: { entries: { main: {} } },
      secrets: { providers },
      gateway: { auth },
      hooks: { enabled: true, token },
    },
    env: {},
    includeFilesystem: false,
    includeChannelSecurity: false,
    ...options,
  });
}

describe("security audit hooks ingress findings", () => {
  it("evaluates hooks ingress auth and routing findings", () => {
    const requestSessionKeyHooks = {
      ...baseHooks,
      allowRequestSessionKey: true,
    } satisfies NonNullable<OpenClawConfig["hooks"]>;
    const cases: Array<
      [
        name: string,
        cfg: OpenClawConfig,
        suffix: string,
        severity: "warn" | "critical",
        env?: NodeJS.ProcessEnv,
        extra?: string,
      ]
    > = [
      ["short token", { hooks: { enabled: true, token: "short" } }, "token_too_short", "warn"],
      [
        "gateway env token reuse",
        { hooks: { enabled: true, token: hookToken } },
        "token_reuse_gateway_token",
        "critical",
        { OPENCLAW_GATEWAY_TOKEN: hookToken },
      ],
      [
        "unset default session",
        { hooks: { enabled: true, token: hookToken } },
        "default_session_key_unset",
        "warn",
      ],
      [
        "wildcard agents",
        { hooks: { ...baseHooks, allowedAgentIds: ["*"] } },
        "allowed_agent_ids_unrestricted",
        "warn",
      ],
      ["local unrestricted agents", { hooks: baseHooks }, "allowed_agent_ids_unrestricted", "warn"],
      [
        "remote unrestricted agents",
        { gateway: { bind: "lan" }, hooks: baseHooks },
        "allowed_agent_ids_unrestricted",
        "critical",
      ],
      [
        "local session override",
        { hooks: requestSessionKeyHooks },
        "request_session_key_enabled",
        "warn",
        undefined,
        "request_session_key_prefixes_missing",
      ],
      [
        "remote session override",
        { gateway: { bind: "lan" }, hooks: requestSessionKeyHooks },
        "request_session_key_enabled",
        "critical",
      ],
    ];
    for (const [name, cfg, suffix, severity, env = process.env, extra] of cases) {
      const findings = collectHooksHardeningFindings(cfg, env);
      expect(hasFinding(findings, `hooks.${suffix}`, severity), name).toBe(true);
      if (extra) {
        expect(hasFinding(findings, `hooks.${extra}`, "warn"), name).toBe(true);
      }
    }
  });

  it("flags explicit audit password reuse when config mode is token", () => {
    const findings = collectHooksHardeningFindings(
      {
        gateway: {
          auth: {
            mode: "token",
            token: "config-gateway-token-1234567890", // pragma: allowlist secret
          },
        },
        hooks: {
          enabled: true,
          token: "runtime-only-gateway-password-1234567890",
        },
      },
      {} as NodeJS.ProcessEnv,
      {
        gatewayAuthOverride: {
          mode: "password",
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(findings, "hooks.token_reuse_gateway_token");
    expect(finding).toMatchObject({
      severity: "critical",
      title: expect.stringContaining("Gateway password"),
      detail: expect.stringContaining("gateway.auth password"),
    });
  });

  it("keeps persisted SecretRef reuse findings when audit password override differs", async () => {
    const report = await auditSecretReuse(
      { mode: "password", password: { source: "env", provider: "default", id: "GW_PASSWORD" } },
      "config-gateway-password-1234567890",
      {
        env: { GW_PASSWORD: "config-gateway-password-1234567890" }, // pragma: allowlist secret
        auditGatewayAuthOverride: {
          mode: "password",
          password: "different-runtime-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(report.findings, "hooks.token_reuse_gateway_token");
    expect(finding).toMatchObject({
      severity: "critical",
      remediation: expect.stringContaining("openclaw doctor --fix"),
    });
  });

  it("flags hooks token reuse of SecretRef-backed trusted-proxy password fallback", async () => {
    const report = await auditSecretReuse(
      {
        mode: "trusted-proxy",
        trustedProxy: { userHeader: "x-forwarded-user" },
        password: { source: "env", provider: "default", id: "GW_PASSWORD" },
      },
      "trusted-proxy-local-password-1234567890",
      { env: { GW_PASSWORD: "trusted-proxy-local-password-1234567890" } }, // pragma: allowlist secret
    );

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(true);
  });

  it("skips unavailable gateway auth SecretRefs when auditing hooks token reuse", async () => {
    const report = await auditSecretReuse(
      {
        mode: "password",
        password: { source: "env", provider: "default", id: "MISSING_GW_PASSWORD" },
      },
      "shared-gateway-password-1234567890",
    );

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });

  it("does not execute gateway auth SecretRefs during hooks token reuse audit", async () => {
    const report = await auditSecretReuse(
      { mode: "password", password: { source: "exec", provider: "vault", id: "GW_PASSWORD" } },
      "shared-gateway-password-1234567890",
      {},
      {
        vault: {
          source: "exec",
          command: "node",
          args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"],
        },
      },
    );

    expect(hasFinding(report.findings, "hooks.token_reuse_gateway_token", "critical")).toBe(false);
  });
});
