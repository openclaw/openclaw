import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";

const audit = (cfg: OpenClawConfig) => collectGatewayConfigFindings(cfg, cfg, {});

function hasFinding(
  checkId: string,
  severity: "warn" | "critical",
  findings: ReturnType<typeof collectGatewayConfigFindings>,
) {
  return findings.some((finding) => finding.checkId === checkId && finding.severity === severity);
}

function dangerousFlags(findings: ReturnType<typeof collectGatewayConfigFindings>) {
  const flags = findings.filter((entry) => entry.checkId === "config.insecure_or_dangerous_flags");
  expect(flags.length).toBeGreaterThan(0);
  return flags;
}

describe("security audit gateway exposure findings", () => {
  it("warns when the MCP Apps bridge is enabled", () => {
    const cfg: OpenClawConfig = { mcp: { apps: { enabled: true } } };
    expect(audit(cfg)).toContainEqual(
      expect.objectContaining({ checkId: "mcp.apps.enabled", severity: "warn" }),
    );
  });

  it("warns on insecure or dangerous flags", () => {
    const cfg: OpenClawConfig = {
      hooks: {
        gmail: { allowUnsafeExternalContent: true },
        mappings: [{ allowUnsafeExternalContent: true }],
      },
      tools: { exec: { applyPatch: { workspaceOnly: false } } },
    };
    const dangerousFindings = dangerousFlags(audit(cfg));
    expect(dangerousFindings.every((finding) => finding.severity === "warn")).toBe(true);
    for (const snippet of [
      "hooks.gmail.allowUnsafeExternalContent=true",
      "hooks.mappings[0].allowUnsafeExternalContent=true",
      "tools.exec.applyPatch.workspaceOnly=false",
    ]) {
      expect(
        dangerousFindings.some((finding) => finding.detail.includes(snippet)),
        snippet,
      ).toBe(true);
    }
  });

  it.each([
    {
      name: "flags wildcard Control UI origins by exposure level on loopback",
      cfg: {
        gateway: { bind: "loopback", controlUi: { allowedOrigins: ["*"] } },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.control_ui.allowed_origins_wildcard",
        severity: "warn",
      },
    },
    {
      name: "flags wildcard Control UI origins by exposure level when exposed",
      cfg: {
        gateway: {
          bind: "lan",
          auth: { mode: "token", token: "very-long-browser-token-0123456789" },
          controlUi: { allowedOrigins: ["*"] },
        },
      } satisfies OpenClawConfig,
      expectedFinding: {
        checkId: "gateway.control_ui.allowed_origins_wildcard",
        severity: "critical",
      },
      expectedNoFinding: "gateway.control_ui.allowed_origins_required",
    },
  ])("$name", ({ cfg, expectedFinding, expectedNoFinding }) => {
    const findings = audit(cfg);
    expect(findings).toContainEqual(expect.objectContaining(expectedFinding));
    if (expectedNoFinding) {
      expect(findings.map((findingLocal) => findingLocal.checkId)).not.toContain(expectedNoFinding);
    }
  });

  it("flags dangerous host-header origin fallback and suppresses missing allowed-origins finding", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth: { mode: "token", token: "very-long-browser-token-0123456789" },
        controlUi: { dangerouslyAllowHostHeaderOriginFallback: true },
      },
    };

    const findings = audit(cfg);
    expect(hasFinding("gateway.control_ui.host_header_origin_fallback", "critical", findings)).toBe(
      true,
    );
    expect(
      findings.some((finding) => finding.checkId === "gateway.control_ui.allowed_origins_required"),
    ).toBe(false);
    const flags = dangerousFlags(findings);
    expect(
      flags.some((finding) =>
        finding.detail.includes("gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"),
      ),
    ).toBe(true);
  });

  it.each([
    {
      name: "loopback trusted-proxy with loopback-only proxies",
      trustedProxies: ["127.0.0.1"],
      expectedSeverity: "warn",
    },
    {
      name: "loopback trusted-proxy with non-loopback proxy range",
      trustedProxies: ["127.0.0.1", "10.0.0.0/8"],
      expectedSeverity: "critical",
    },
    {
      name: "loopback trusted-proxy with 127.0.0.2",
      trustedProxies: ["127.0.0.2"],
      expectedSeverity: "critical",
    },
    {
      name: "loopback trusted-proxy with partial loopback CIDR prefix",
      trustedProxies: ["127.0.0.1/32abc"],
      expectedSeverity: "critical",
    },
  ] as const)(
    "scores X-Real-IP fallback risk by gateway exposure: $name",
    ({ trustedProxies, expectedSeverity }) => {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "loopback",
          allowRealIpFallback: true,
          trustedProxies: [...trustedProxies],
          auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
        },
      };
      expect(hasFinding("gateway.real_ip_fallback_enabled", expectedSeverity, audit(cfg))).toBe(
        true,
      );
    },
  );

  it.each([
    { bind: "loopback", expectedSeverity: "warn" },
    { bind: "lan", expectedSeverity: "critical" },
  ] as const)("scores mDNS full mode risk on $bind", ({ bind, expectedSeverity }) => {
    const cfg: OpenClawConfig = {
      gateway: { bind, auth: { mode: "token", token: "very-long-token-1234567890" } },
      discovery: { mdns: { mode: "full" } },
    };
    expect(hasFinding("discovery.mdns_full_mode", expectedSeverity, audit(cfg))).toBe(true);
  });

  it("evaluates trusted-proxy auth guardrails on lan", () => {
    const proxy = { userHeader: "x-forwarded-user" };
    const allowed = { ...proxy, allowUsers: ["nick@example.com"] };
    const cases: Array<[string, "warn" | "critical", GatewayTrustedProxyConfig, string[]?]> = [
      ["auth", "critical", proxy],
      ["no_proxies", "critical", proxy, []],
      ["no_user_header", "critical", {} as never],
      ["no_allowlist", "warn", { ...proxy, allowUsers: [] }],
      ["allow_loopback", "warn", { ...allowed, allowLoopback: true }, ["127.0.0.1"]],
      ["device_auto_approve", "warn", { ...allowed, deviceAutoApprove: { enabled: true } }],
      [
        "device_auto_approve_admin",
        "critical",
        {
          ...allowed,
          deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
        },
      ],
    ];

    for (const [suffix, severity, trustedProxy, proxies] of cases) {
      const cfg: OpenClawConfig = {
        gateway: {
          bind: "lan",
          trustedProxies: proxies ?? ["10.0.0.1"],
          auth: { mode: "trusted-proxy", trustedProxy },
        },
      };
      const findings = audit(cfg);
      expect(hasFinding(`gateway.trusted_proxy_${suffix}`, severity, findings), suffix).toBe(true);
      const checkIds = findings.map((finding) => finding.checkId);
      expect(checkIds, suffix).toContain("gateway.trusted_proxy_auth");
      for (const id of [
        "gateway.bind_no_auth",
        "gateway.loopback_no_auth",
        "gateway.auth_no_rate_limit",
      ]) {
        expect(checkIds, suffix).not.toContain(id);
      }
    }
  });
});
