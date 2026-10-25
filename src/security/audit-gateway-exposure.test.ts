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
import { runSecurityAuditCore } from "./audit.js";

const audit = (cfg: OpenClawConfig) => collectGatewayConfigFindings(cfg, cfg, {});
const auth = { mode: "token", token: "very-long-browser-token-0123456789" } as const;

const dangerousId = "config.insecure_or_dangerous_flags";
const originRequired = "gateway.control_ui.allowed_origins_required";

describe("security audit gateway exposure findings", () => {
  it("warns when the MCP Apps bridge is enabled", () => {
    checkFinding(audit({ mcp: { apps: { enabled: true } } }), "mcp.apps.enabled", warn);
  });

  it("warns on unsafe hook mappings", () => {
    checkFinding(
      audit({ hooks: { mappings: [{ allowUnsafeExternalContent: true }] } }),
      dangerousId,
      {
        ...warn,
        detail: ["hooks.mappings[0].allowUnsafeExternalContent=true"],
      },
    );
  });

  it.each([
    ["loopback", "warn"],
    ["lan", "critical"],
  ] as const)("flags wildcard Control UI origins on %s", (bind, severity) => {
    const findings = audit({
      gateway: { bind, ...(bind === "lan" ? { auth } : {}), controlUi: { allowedOrigins: ["*"] } },
    });
    checkFinding(findings, "gateway.control_ui.allowed_origins_wildcard", { severity });
    if (bind === "lan") {
      expect(findings.map((finding) => finding.checkId)).not.toContain(originRequired);
    }
  });

  it("flags dangerous host-header origin fallback and suppresses missing allowed-origins finding", () => {
    const findings = audit({
      gateway: { bind: "lan", auth, controlUi: { dangerouslyAllowHostHeaderOriginFallback: true } },
    });
    checkFinding(findings, "gateway.control_ui.host_header_origin_fallback", critical);
    expect(findings.map((finding) => finding.checkId)).not.toContain(originRequired);
    checkFinding(findings, dangerousId, {
      detail: ["gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true"],
    });
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
    checkFinding(audit(cfg), "gateway.real_ip_fallback_enabled", { severity: expectedSeverity });
  });

  it.each([
    { bind: "loopback", expectedSeverity: "warn" },
    { bind: "lan", expectedSeverity: "critical" },
  ] as const)("scores mDNS full mode risk on $bind", ({ bind, expectedSeverity }) => {
    const cfg: OpenClawConfig = {
      gateway: { bind, auth },
      discovery: { mdns: { mode: "full" } },
    };
    checkFinding(audit(cfg), "discovery.mdns_full_mode", { severity: expectedSeverity });
  });

  it("evaluates trusted-proxy auth guardrails on lan", () => {
    const proxy = { userHeader: "x-forwarded-user" };
    const allowed = { ...proxy, allowUsers: ["nick@example.com"] };
    const cases: Array<[string, "warn" | "critical", GatewayTrustedProxyConfig, string[]?]> = [
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
      const findings = audit({
        gateway: {
          bind: "lan",
          trustedProxies: proxies ?? ["10.0.0.1"],
          auth: { mode: "trusted-proxy", trustedProxy },
        },
      });
      checkFinding(findings, `gateway.trusted_proxy_${suffix}`, { severity });
      const checkIds = findings.map((finding) => finding.checkId);
      checkFinding(findings, "gateway.trusted_proxy_auth", critical);
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

  const dm = { feishu: { groupPolicy: "disabled", dmPolicy: "open" } } as const;
  const scopedRoom: OpenClawConfig = {
    session: { groupScope: "per-group" },
    ...bindings({
      agentId: "support",
      session: { groupScope: "main" },
      match: {
        channel: "discord",
        accountId: "work",
        peer: { kind: "channel", id: "1234567890" },
        guildId: "9876543210",
        roles: ["operators", "reviewers"],
      },
    }),
  };
  it.each<{ name: string; cfg: OpenClawConfig; id: string | string[]; expected: Expected | false }>`
    name                                 | cfg                                                                                                                                          | id                         | expected
    ${"group elevated"}                  | ${openGroup({ elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } })}                                                               | ${elevated}                | ${critical}
    ${"open group runtime"}              | ${openGroup()}                                                                                                                               | ${runtime}                 | ${critical}
    ${"sandboxed runtime"}               | ${openGroup({ profile: "coding" }, { defaults: { sandbox: { mode: "all" } } })}                                                              | ${runtime}                 | ${false}
    ${"workspace-only filesystem"}       | ${openGroup({ profile: "coding", deny: ["group:runtime"], fs: { workspaceOnly: true } })}                                                    | ${runtime}                 | ${false}
    ${"configured group target"}         | ${channel({ discord: { groupPolicy: "allowlist", guilds: { "1234567890": { channels: { "7777777777": { enabled: true } } } } } })}           | ${multiUser}               | ${{ ...warn, detail: ['channels.discord.groupPolicy="allowlist" with configured group targets'] }}
    ${"unconfigured group target"}       | ${channel({ discord: { groupPolicy: "allowlist" } })}                                                                                        | ${[multiUser, groupScope]} | ${false}
    ${"global shared session"}           | ${{ session: { groupScope: "main" } }}                                                                                                       | ${groupScope}              | ${{ ...warn, detail: ['session.groupScope="main"', "all group/channel rooms"] }}
    ${"binding-scoped shared session"}   | ${scopedRoom}                                                                                                                                | ${groupScope}              | ${{ ...warn, detail: ["discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers"], notDetail: ["all group/channel rooms"] }}
    ${"direct binding is not a group"}   | ${bindings({ agentId: "support", match: { channel: "whatsapp", peer: { kind: "direct", id: "user-a" } }, session: { groupScope: "main" } })} | ${groupScope}              | ${false}
    ${"first matching binding isolates"} | ${bindings(room("isolated", "per-group", "group"), room("shared", "main", "channel"))}                                                       | ${groupScope}              | ${false}
    ${"first matching binding shares"}   | ${bindings(room("shared", "main", "channel"), room("isolated", "per-group", "group"))}                                                       | ${groupScope}              | ${{ detail: ["discord accountId=work peer=channel:room-1"] }}
    ${"specific group binding"}          | ${bindings(room("isolated", "per-group"), room("shared", "main", "group"))}                                                                  | ${groupScope}              | ${{ detail: ["discord accountId=work peer=group:room-1"] }}
    ${"DM elevated"}                     | ${channel(dm, { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } })}                                                           | ${elevated}                | ${{ ...critical, detail: ["channels.feishu.dmPolicy"] }}
    ${"DM runtime"}                      | ${channel(dm, { ...disabled, profile: "coding" })}                                                                                           | ${runtime}                 | ${{ ...critical, detail: ["channels.feishu.dmPolicy"] }}
    ${"account DM override"}             | ${{ channels: { discord: { dmPolicy: "allowlist", accounts: { work: { dmPolicy: "open" } } } } }}                                            | ${elevated}                | ${{ detail: ["channels.discord.accounts.work.dmPolicy"], notDetail: ["channels.discord.dmPolicy"] }}
    ${"legacy nested DM"}                | ${{ channels: { discord: { dm: { policy: "open" } } } } as unknown as OpenClawConfig}                                                        | ${elevated}                | ${{ detail: ["channels.discord.dm.policy"] }}
    ${"Matrix nested DM"}                | ${{ channels: { matrix: { dm: { policy: "open" } } } }}                                                                                      | ${elevated}                | ${{ detail: ["channels.matrix.dm.policy"], remediation: ["each listed group/DM policy"], notRemediation: ["dmPolicy"] }}
    ${"group control plane"}             | ${openGroup({ profile: "coding" })}                                                                                                          | ${control}                 | ${{ ...critical, detail: ["channels.whatsapp.groupPolicy"] }}
    ${"DM control plane"}                | ${openDm({ allow: ["gateway"] })}                                                                                                            | ${control}                 | ${{ ...critical, detail: ["channels.slack.dmPolicy"] }}
    ${"additive control policy"}         | ${openDm({ profile: "messaging", alsoAllow: ["cron"] })}                                                                                     | ${control}                 | ${{}}
    ${"agent control policy"}            | ${openGroup({ profile: "messaging" }, { entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } } })}                    | ${control}                 | ${{ detail: ["agents.entries.ops", "agents.defaults"] }}
    ${"denied control tools"}            | ${openGroup({ profile: "coding", deny: ["gateway", "cron", "plugins"] })}                                                                    | ${control}                 | ${false}
    ${"non-control tools"}               | ${openGroup({ allow: ["nodes", "computer"] })}                                                                                               | ${control}                 | ${false}
    ${"closed group policy"}             | ${channel({ whatsapp: { groupPolicy: "allowlist" } }, { ...disabled, profile: "coding" })}                                                   | ${control}                 | ${false}
  `("evaluates $name", ({ cfg, id, expected }) => {
    if (expected === false) {
      absent(cfg, ...(Array.isArray(id) ? id : [id]));
    } else {
      for (const checkId of Array.isArray(id) ? id : [id]) {
        check(cfg, checkId, expected);
      }
    }
  });

  it("prefers canonical DM policy over legacy nested policy", () => {
    const canonical = trustAudit({
      channels: { discord: { dmPolicy: "allowlist", dm: { policy: "open" } } },
    } as unknown as OpenClawConfig);
    expect(
      canonical.some((entry) => entry.checkId.startsWith("security.exposure.open_groups_")),
    ).toBe(false);
  });
});

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
  const requestSessionKeyHooks = { ...baseHooks, allowRequestSessionKey: true };
  it.each<{
    name: string;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv | undefined;
    ids: string[];
    severity: string;
  }>`
    name                              | cfg                                                            | env                                      | ids                                                                        | severity
    ${"short token"}                  | ${{ hooks: { enabled: true, token: "short" } }}                | ${undefined}                             | ${["token_too_short"]}                                                     | ${"warn"}
    ${"environment token reuse"}      | ${{ hooks: { enabled: true, token: hookToken } }}              | ${{ OPENCLAW_GATEWAY_TOKEN: hookToken }} | ${["token_reuse_gateway_token"]}                                           | ${"critical"}
    ${"missing default session"}      | ${{ hooks: { enabled: true, token: hookToken } }}              | ${undefined}                             | ${["default_session_key_unset"]}                                           | ${"warn"}
    ${"wildcard routing"}             | ${{ hooks: { ...baseHooks, allowedAgentIds: ["*"] } }}         | ${undefined}                             | ${["allowed_agent_ids_unrestricted"]}                                      | ${"warn"}
    ${"unrestricted local routing"}   | ${{ hooks: baseHooks }}                                        | ${undefined}                             | ${["allowed_agent_ids_unrestricted"]}                                      | ${"warn"}
    ${"unrestricted remote routing"}  | ${{ gateway: { bind: "lan" }, hooks: baseHooks }}              | ${undefined}                             | ${["allowed_agent_ids_unrestricted"]}                                      | ${"critical"}
    ${"unrestricted request session"} | ${{ hooks: requestSessionKeyHooks }}                           | ${undefined}                             | ${["request_session_key_enabled", "request_session_key_prefixes_missing"]} | ${"warn"}
    ${"remote request session"}       | ${{ gateway: { bind: "lan" }, hooks: requestSessionKeyHooks }} | ${undefined}                             | ${["request_session_key_enabled"]}                                         | ${"critical"}
  `("reports $name", ({ cfg, env, ids, severity }) => {
    const findings = collectHooksHardeningFindings(cfg, env);
    for (const id of ids) {
      checkFinding(findings, `hooks.${id}`, { severity });
    }
  });

  it("flags explicit audit password reuse when config mode is token", () => {
    const runtimePassword = "runtime-only-gateway-password-1234567890";
    checkFinding(
      collectHooksHardeningFindings(
        {
          gateway: { auth },
          hooks: { enabled: true, token: runtimePassword },
        },
        {},
        {
          gatewayAuthOverride: {
            mode: "password",
            password: runtimePassword,
          },
        },
      ),
      reuseId,
      {
        severity: "critical",
        detail: ["gateway.auth password"],
      },
    );
  });

  type ReuseCase = {
    name: string;
    auth: NonNullable<OpenClawConfig["gateway"]>["auth"];
    token: string;
    options: Partial<AuditOptions>;
    providers: NonNullable<OpenClawConfig["secrets"]>["providers"];
    expected: Expected | false;
  };
  it.each<ReuseCase>`
    name                                             | auth                                                                                                  | token                                   | options                                                                                                                                         | providers                                                                                                                     | expected
    ${"persisted password despite runtime override"} | ${{ mode: "password", password: passwordRef }}                                                        | ${gatewayPassword}                      | ${{ env: { GW_PASSWORD: gatewayPassword }, auditGatewayAuthOverride: { mode: "password", password: "different-runtime-password-1234567890" } }} | ${undefined}                                                                                                                  | ${{ ...critical, remediation: ["openclaw doctor --fix"] }}
    ${"trusted-proxy password fallback"}             | ${{ mode: "trusted-proxy", trustedProxy: { userHeader: "x-forwarded-user" }, password: passwordRef }} | ${gatewayPassword}                      | ${{ env: { GW_PASSWORD: gatewayPassword } }}                                                                                                    | ${undefined}                                                                                                                  | ${critical}
    ${"unavailable reference"}                       | ${{ mode: "password", password: { ...passwordRef, id: "MISSING_GW_PASSWORD" } }}                      | ${"shared-gateway-password-1234567890"} | ${{}}                                                                                                                                           | ${undefined}                                                                                                                  | ${false}
    ${"exec references are not executed"}            | ${{ mode: "password", password: { source: "exec", provider: "vault", id: "GW_PASSWORD" } }}           | ${"shared-gateway-password-1234567890"} | ${{}}                                                                                                                                           | ${{ vault: { source: "exec", command: "node", args: ["-e", "process.stdout.write('shared-gateway-password-1234567890')"] } }} | ${false}
  `("audits reuse: $name", async ({ auth: gatewayAuth, token, options, providers, expected }) => {
    const { findings } = await auditSecretReuse(gatewayAuth, token, options, providers);
    if (expected === false) {
      expect(findings).not.toContainEqual(
        expect.objectContaining({ checkId: reuseId, ...critical }),
      );
    } else {
      checkFinding(findings, reuseId, expected);
    }
  });
});

const web = { search: { enabled: true }, fetch: { enabled: true } };
const smallModel = "ollama/mistral-8b";
const noWeb = { deny: ["web_search", "web_fetch", "browser"] };
function modelConfig(
  primary = smallModel,
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
  tools: OpenClawConfig["tools"] = { web },
  enabled = true,
): OpenClawConfig {
  return { agents: { defaults: { model: { primary }, ...defaults } }, tools, browser: { enabled } };
}
function risk(cfg: OpenClawConfig, expected: Expected, env: NodeJS.ProcessEnv = {}) {
  checkFinding(collectSmallModelRiskFindings({ cfg, env }), "models.small_params", expected);
}

describe("security audit small-model risk findings", () => {
  it("preserves canonical model paths and their agent policy context", () => {
    const entries = {
      simple: { model: smallModel, tools: noWeb },
      ops: { model: { primary: "ollama/gemma-4b", fallbacks: ["ollama/phi-3b"] }, tools: noWeb },
    };
    risk(
      { ...modelConfig(), agents: { entries } },
      {
        severity: "info",
        detail: [
          `${smallModel} (8B) @ agents.entries.simple.model`,
          "ollama/gemma-4b (4B) @ agents.entries.ops.model.primary",
          "ollama/phi-3b (3B) @ agents.entries.ops.model.fallbacks",
          "web=[off]",
        ],
      },
    );
  });

  const remoteModel = "openrouter/google/gemma-3-4b-it:free";
  it.each<{ name: string; cfg: OpenClawConfig; expected: Expected; env: NodeJS.ProcessEnv }>`
    name                            | cfg                                                                                                                                 | expected                                                                                  | env
    ${"exposed web tools"}          | ${modelConfig()}                                                                                                                    | ${{ severity: "critical", detail: ["mistral-8b", "web_search", "web_fetch", "browser"] }} | ${process.env}
    ${"sandbox with web disabled"}  | ${modelConfig(smallModel, { sandbox: { mode: "all" } }, { web: { search: { enabled: false }, fetch: { enabled: false } } }, false)} | ${{ severity: "info", detail: ["mistral-8b", "sandbox=all"] }}                            | ${process.env}
    ${"configured model alias"}     | ${modelConfig("tiny", { models: { [smallModel]: { alias: "tiny" } } })}                                                             | ${{ detail: [smallModel, "@ agents.defaults.model.primary"], notDetail: ["- tiny"] }}     | ${{}}
    ${"provider/model deny policy"} | ${modelConfig(remoteModel, {}, { web, byProvider: { [remoteModel]: noWeb } })}                                                      | ${{ severity: "info", detail: [remoteModel, "web=[off]"] }}                               | ${{}}
  `("scores $name", ({ cfg, expected, env }) => risk(cfg, expected, env));
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
