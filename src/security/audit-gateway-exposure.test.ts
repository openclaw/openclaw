import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { resolveGatewayProbeAuthSafe } from "../gateway/probe-auth.js";
import { collectDeepProbeFindings } from "./audit-deep-probe-findings.js";
import { collectSmallModelRiskFindings } from "./audit-extra.summary.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
  collectHooksHardeningFindings,
} from "./audit-extra.sync.js";
import { collectGatewayConfigFindings } from "./audit-gateway-config.js";
import { collectAuditModelRefs } from "./audit-model-refs.js";
import { runSecurityAuditCore } from "./audit.js";

const audit = (cfg: OpenClawConfig) => collectGatewayConfigFindings(cfg, cfg, {});
const auth = { mode: "token", token: "very-long-browser-token-0123456789" } as const;

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
    ["loopback", "warn"],
    ["lan", "critical"],
  ] as const)("flags wildcard Control UI origins on %s", (bind, severity) => {
    const findings = audit({
      gateway: { bind, ...(bind === "lan" ? { auth } : {}), controlUi: { allowedOrigins: ["*"] } },
    });
    expect(hasFinding("gateway.control_ui.allowed_origins_wildcard", severity, findings)).toBe(
      true,
    );
    if (bind === "lan") {
      expect(findings.map((finding) => finding.checkId)).not.toContain(
        "gateway.control_ui.allowed_origins_required",
      );
    }
  });

  it("flags dangerous host-header origin fallback and suppresses missing allowed-origins finding", () => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "lan",
        auth,
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
    [["127.0.0.1"], "warn"],
    [["127.0.0.1", "10.0.0.0/8"], "critical"],
    [["127.0.0.2"], "critical"],
    [["127.0.0.1/32abc"], "critical"],
  ] as const)("scores X-Real-IP fallback risk for %j", (trustedProxies, expectedSeverity) => {
    const cfg: OpenClawConfig = {
      gateway: {
        bind: "loopback",
        allowRealIpFallback: true,
        trustedProxies: [...trustedProxies],
        auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" } },
      },
    };
    expect(hasFinding("gateway.real_ip_fallback_enabled", expectedSeverity, audit(cfg))).toBe(true);
  });

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

const exposure = "security.exposure.open_groups_with_";
const multiUser = "security.trust_model.multi_user_heuristic";
const groupScope = "security.trust_model.group_scope_main";
const elevated = exposure + "elevated";
const runtime = exposure + "runtime_or_fs";
const control = exposure + "control_plane_tools";
const critical = { severity: "critical" };
const warn = { severity: "warn" };
const disabled = { elevated: { enabled: false } };
function trustAudit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}
function channel(
  channels: OpenClawConfig["channels"],
  tools: OpenClawConfig["tools"] = disabled,
): OpenClawConfig {
  return { channels, tools };
}
function openGroup(
  tools: OpenClawConfig["tools"] = {},
  agents?: OpenClawConfig["agents"],
): OpenClawConfig {
  return { ...channel({ whatsapp: { groupPolicy: "open" } }, { ...disabled, ...tools }), agents };
}
function openDm(tools: OpenClawConfig["tools"]): OpenClawConfig {
  return channel({ slack: { dmPolicy: "open" } }, { ...disabled, ...tools });
}
type Binding = NonNullable<OpenClawConfig["bindings"]>[number];
function room(agentId: string, scope: "main" | "per-group", kind?: "group" | "channel"): Binding {
  return {
    agentId,
    match: {
      channel: "discord",
      accountId: "work",
      ...(kind ? { peer: { kind, id: "room-1" } } : {}),
    },
    session: { groupScope: scope },
  };
}
const bindings = (...entries: Binding[]): OpenClawConfig => ({ bindings: entries });
type Expected = {
  severity?: string;
  detail?: string[];
  notDetail?: string[];
  remediation?: string[];
  notRemediation?: string[];
};
function checkFinding(
  findings: ReturnType<typeof trustAudit>,
  id: string,
  expected: Expected = {},
) {
  const finding = expectDefined(
    findings.find((entry) => entry.checkId === id),
    id,
  );
  const { detail, notDetail, remediation, notRemediation, ...match } = expected;
  expect(finding).toMatchObject(match);
  for (const [value, includes, excludes] of [
    [finding.detail, detail, notDetail],
    [finding.remediation, remediation, notRemediation],
  ] as const) {
    for (const text of includes ?? []) {
      expect(value).toContain(text);
    }
    for (const text of excludes ?? []) {
      expect(value).not.toContain(text);
    }
  }
}
const check = (cfg: OpenClawConfig, id: string, expected?: Expected) =>
  checkFinding(trustAudit(cfg), id, expected);
function absent(cfg: OpenClawConfig, ...ids: string[]) {
  const findings = trustAudit(cfg);
  for (const checkId of ids) {
    expect(findings).not.toContainEqual(expect.objectContaining({ checkId }));
  }
}

describe("security audit trust model findings", () => {
  it.each([
    { name: "inherited", groupPolicy: undefined, expected: true },
    { name: "explicitly disabled", groupPolicy: "disabled", expected: false },
  ] as const)("audits account group targets with $name policy", ({ groupPolicy, expected }) => {
    const findings = collectLikelyMultiUserSetupFindings({
      channels: {
        discord: {
          groupPolicy: "allowlist",
          accounts: {
            work: {
              ...(groupPolicy ? { groupPolicy } : {}),
              guilds: { "1234567890": {} },
            },
          },
        },
      },
    });
    const finding = findings.find((entry) => entry.checkId === multiUser);
    expect(Boolean(finding)).toBe(expected);
    if (expected) {
      expect(finding?.detail).toContain(
        'channels.discord.accounts.work.groupPolicy="allowlist" with configured group targets',
      );
    }
  });

  it("evaluates trust-model exposure findings", () => {
    check(
      openGroup({ elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } }),
      elevated,
      critical,
    );
    check(openGroup(), runtime, critical);
    absent(openGroup({ profile: "coding" }, { defaults: { sandbox: { mode: "all" } } }), runtime);
    absent(
      openGroup({ profile: "coding", deny: ["group:runtime"], fs: { workspaceOnly: true } }),
      runtime,
    );
    check(
      channel({
        discord: {
          groupPolicy: "allowlist",
          guilds: {
            "1234567890": { channels: { "7777777777": { enabled: true } } },
          },
        },
      }),
      multiUser,
      {
        ...warn,
        detail: ['channels.discord.groupPolicy="allowlist" with configured group targets'],
      },
    );
    absent(channel({ discord: { groupPolicy: "allowlist" } }), multiUser, groupScope);
    check({ session: { groupScope: "main" } }, groupScope, {
      ...warn,
      detail: ['session.groupScope="main"', "all group/channel rooms"],
    });
    check(
      {
        session: { groupScope: "per-group" },
        ...bindings({
          agentId: "support",
          match: {
            channel: "discord",
            accountId: "work",
            peer: { kind: "channel", id: "1234567890" },
            guildId: "9876543210",
            roles: ["operators", "reviewers"],
          },
          session: { groupScope: "main" },
        }),
      },
      groupScope,
      {
        ...warn,
        detail: [
          "discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers",
        ],
        notDetail: ["all group/channel rooms"],
      },
    );
    absent(
      bindings({
        agentId: "support",
        match: { channel: "whatsapp", peer: { kind: "direct", id: "user-a" } },
        session: { groupScope: "main" },
      }),
      groupScope,
    );
    absent(
      bindings(room("isolated", "per-group", "group"), room("shared", "main", "channel")),
      groupScope,
    );
    check(
      bindings(room("shared", "main", "channel"), room("isolated", "per-group", "group")),
      groupScope,
      { detail: ["discord accountId=work peer=channel:room-1"] },
    );
    check(bindings(room("isolated", "per-group"), room("shared", "main", "group")), groupScope, {
      detail: ["discord accountId=work peer=group:room-1"],
    });
    const dm = { feishu: { groupPolicy: "disabled", dmPolicy: "open" } } as const;
    check(
      channel(dm, { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } }),
      elevated,
      { ...critical, detail: ["channels.feishu.dmPolicy"] },
    );
    check(channel(dm, { ...disabled, profile: "coding" }), runtime, {
      ...critical,
      detail: ["channels.feishu.dmPolicy"],
    });
    check(
      {
        channels: { discord: { dmPolicy: "allowlist", accounts: { work: { dmPolicy: "open" } } } },
      },
      elevated,
      {
        detail: ["channels.discord.accounts.work.dmPolicy"],
        notDetail: ["channels.discord.dmPolicy"],
      },
    );
    check(
      { channels: { discord: { dm: { policy: "open" } } } } as unknown as OpenClawConfig,
      elevated,
      { detail: ["channels.discord.dm.policy"] },
    );
    check({ channels: { matrix: { dm: { policy: "open" } } } }, elevated, {
      detail: ["channels.matrix.dm.policy"],
      remediation: ["each listed group/DM policy"],
      notRemediation: ["dmPolicy"],
    });
    const canonical = trustAudit({
      channels: { discord: { dmPolicy: "allowlist", dm: { policy: "open" } } },
    } as unknown as OpenClawConfig);
    expect(
      canonical.some((entry) => entry.checkId.startsWith("security.exposure.open_groups_")),
    ).toBe(false);
    check(openGroup({ profile: "coding" }), control, {
      ...critical,
      detail: ["channels.whatsapp.groupPolicy"],
    });
    check(openDm({ allow: ["gateway"] }), control, {
      ...critical,
      detail: ["channels.slack.dmPolicy"],
    });
    check(openDm({ profile: "messaging", alsoAllow: ["cron"] }), control);
    check(
      openGroup(
        { profile: "messaging" },
        { entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } } },
      ),
      control,
      {
        detail: ["agents.entries.ops", "agents.defaults"],
      },
    );
    absent(openGroup({ profile: "coding", deny: ["gateway", "cron", "plugins"] }), control);
    absent(openGroup({ allow: ["nodes", "computer"] }), control);
    absent(
      channel({ whatsapp: { groupPolicy: "allowlist" } }, { ...disabled, profile: "coding" }),
      control,
    );
  });
});

function hasHookFinding(
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
const passwordRef = { source: "env", provider: "default", id: "GW_PASSWORD" } as const;
const gatewayPassword = "config-gateway-password-1234567890";
const reuseId = "hooks.token_reuse_gateway_token";
function auditSecretReuse(
  gatewayAuth: NonNullable<OpenClawConfig["gateway"]>["auth"],
  token: string,
  options: Partial<AuditOptions> = {},
  providers: NonNullable<OpenClawConfig["secrets"]>["providers"] = { default: { source: "env" } },
) {
  return runSecurityAuditCore({
    config: {
      agents: { entries: { main: {} } },
      secrets: { providers },
      gateway: { auth: gatewayAuth },
      hooks: { enabled: true, token },
    },
    env: {},
    includeFilesystem: false,
    plugins: [],
    ...options,
  });
}

describe("security audit hooks ingress findings", () => {
  it("evaluates hooks ingress auth and routing findings", () => {
    const requestSessionKeyHooks = { ...baseHooks, allowRequestSessionKey: true };
    function checkHooks(
      cfg: OpenClawConfig,
      suffix: string,
      severity: "warn" | "critical" = "warn",
      env = process.env,
    ) {
      const findings = collectHooksHardeningFindings(cfg, env);
      expect(hasHookFinding(findings, `hooks.${suffix}`, severity), suffix).toBe(true);
      return findings;
    }
    checkHooks({ hooks: { enabled: true, token: "short" } }, "token_too_short");
    checkHooks(
      { hooks: { enabled: true, token: hookToken } },
      "token_reuse_gateway_token",
      "critical",
      {
        OPENCLAW_GATEWAY_TOKEN: hookToken,
      },
    );
    checkHooks({ hooks: { enabled: true, token: hookToken } }, "default_session_key_unset");
    checkHooks(
      { hooks: { ...baseHooks, allowedAgentIds: ["*"] } },
      "allowed_agent_ids_unrestricted",
    );
    checkHooks({ hooks: baseHooks }, "allowed_agent_ids_unrestricted");
    checkHooks(
      { gateway: { bind: "lan" }, hooks: baseHooks },
      "allowed_agent_ids_unrestricted",
      "critical",
    );
    const local = checkHooks({ hooks: requestSessionKeyHooks }, "request_session_key_enabled");
    expect(hasHookFinding(local, "hooks.request_session_key_prefixes_missing", "warn")).toBe(true);
    checkHooks(
      { gateway: { bind: "lan" }, hooks: requestSessionKeyHooks },
      "request_session_key_enabled",
      "critical",
    );
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
      {},
      {
        gatewayAuthOverride: {
          mode: "password",
          password: "runtime-only-gateway-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(findings, reuseId);
    expect(finding).toMatchObject({
      severity: "critical",
      detail: expect.stringContaining("gateway.auth password"),
    });
  });

  it("keeps persisted SecretRef reuse findings when audit password override differs", async () => {
    const report = await auditSecretReuse(
      { mode: "password", password: passwordRef },
      gatewayPassword,
      {
        env: { GW_PASSWORD: gatewayPassword },
        auditGatewayAuthOverride: {
          mode: "password",
          password: "different-runtime-password-1234567890", // pragma: allowlist secret
        },
      },
    );

    const finding = getFinding(report.findings, reuseId);
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
        password: passwordRef,
      },
      "trusted-proxy-local-password-1234567890",
      { env: { GW_PASSWORD: "trusted-proxy-local-password-1234567890" } }, // pragma: allowlist secret
    );

    expect(hasHookFinding(report.findings, reuseId, "critical")).toBe(true);
  });

  it("skips unavailable gateway auth SecretRefs when auditing hooks token reuse", async () => {
    const report = await auditSecretReuse(
      {
        mode: "password",
        password: { ...passwordRef, id: "MISSING_GW_PASSWORD" },
      },
      "shared-gateway-password-1234567890",
    );

    expect(hasHookFinding(report.findings, reuseId, "critical")).toBe(false);
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

    expect(hasHookFinding(report.findings, reuseId, "critical")).toBe(false);
  });
});

const web = { search: { enabled: true }, fetch: { enabled: true } };
const browser = { enabled: true };
function modelConfig(
  primary: string,
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return { agents: { defaults: { model: { primary }, ...defaults } }, tools: { web }, browser };
}
function risk(cfg: OpenClawConfig, expected: Expected, env: NodeJS.ProcessEnv = {}) {
  checkFinding(collectSmallModelRiskFindings({ cfg, env }), "models.small_params", expected);
}

describe("security audit small-model risk findings", () => {
  it("reports canonical paths for agent model references", () => {
    expect(
      collectAuditModelRefs({
        agents: {
          entries: {
            simple: { model: "ollama/mistral-8b" },
            structured: { model: { primary: "ollama/gemma-4b", fallbacks: ["ollama/phi-3b"] } },
          },
        },
      } satisfies OpenClawConfig),
    ).toEqual([
      { id: "ollama/mistral-8b", source: "agents.entries.simple.model" },
      { id: "ollama/gemma-4b", source: "agents.entries.structured.model.primary" },
      { id: "ollama/phi-3b", source: "agents.entries.structured.model.fallbacks" },
    ]);
  });

  it("preserves agent policy context for canonical model source paths", () => {
    risk(
      {
        agents: {
          entries: {
            ops: {
              model: { primary: "ollama/mistral-8b" },
              tools: { deny: ["web_search", "web_fetch", "browser"] },
            },
          },
        },
        tools: { web },
        browser,
      },
      { severity: "info", detail: ["@ agents.entries.ops.model.primary", "web=[off]"] },
    );
  });

  it("scores small-model risk by tool/sandbox exposure", () => {
    risk(
      modelConfig("ollama/mistral-8b"),
      {
        severity: "critical",
        detail: ["mistral-8b", "web_search", "web_fetch", "browser"],
      },
      process.env,
    );
    risk(
      {
        ...modelConfig("ollama/mistral-8b", { sandbox: { mode: "all" } }),
        tools: { web: { search: { enabled: false }, fetch: { enabled: false } } },
        browser: { enabled: false },
      },
      { severity: "info", detail: ["mistral-8b", "sandbox=all"] },
      process.env,
    );
  });

  it("resolves configured aliases before parameter-size classification", () => {
    risk(modelConfig("tiny", { models: { "ollama/mistral-8b": { alias: "tiny" } } }), {
      detail: ["ollama/mistral-8b", "@ agents.defaults.model.primary"],
      notDetail: ["- tiny"],
    });
  });

  it("honors provider/model tool deny policy before reporting web exposure", () => {
    risk(
      {
        ...modelConfig("openrouter/google/gemma-3-4b-it:free"),
        tools: {
          web,
          byProvider: {
            "openrouter/google/gemma-3-4b-it:free": {
              deny: ["web_search", "web_fetch", "browser"],
            },
          },
        },
      },
      {
        severity: "info",
        detail: ["openrouter/google/gemma-3-4b-it:free", "web=[off]"],
      },
    );
  });
});

describe("security audit gateway auth selection", () => {
  it("adds warning finding when probe auth SecretRef is unavailable", () => {
    const token = { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" } as const;
    const cfg: OpenClawConfig = {
      gateway: { mode: "local", auth: { mode: "token", token } },
      secrets: { providers: { default: { source: "env" } } },
    };

    const result = resolveGatewayProbeAuthSafe({ cfg, mode: "local", env: {} });
    const findings = collectDeepProbeFindings({
      deep: {
        gateway: {
          attempted: true,
          url: "ws://127.0.0.1:18789",
          ok: true,
          error: null,
          close: null,
        },
      },
      authWarning: result.warning,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        detail: expect.stringContaining("gateway.auth.token"),
      }),
    );
  });
});
