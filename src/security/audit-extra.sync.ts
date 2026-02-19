import { isToolAllowedByPolicies } from "../agents/pi-tools.policy.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
/**
 * Synchronous security audit collector functions.
 *
 * These functions analyze config-based security properties without I/O.
 */
import type { SandboxToolPolicy } from "../agents/sandbox/types.js";
import { getBlockedBindReason } from "../agents/sandbox/validate-sandbox-security.js";
import { resolveToolProfilePolicy } from "../agents/tool-policy.js";
import { resolveBrowserConfig } from "../browser/config.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import { inferParamBFromIdOrName } from "../shared/model-param-b.js";
import { pickSandboxToolPolicy } from "./audit-tool-policy.js";

export type SecurityAuditFinding = {
  checkId: string;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  remediation?: string;
};

const SMALL_MODEL_PARAM_B_MAX = 300;

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function summarizeGroupPolicy(cfg: OpenClawConfig): {
  open: number;
  allowlist: number;
  other: number;
} {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return { open: 0, allowlist: 0, other: 0 };
  }
  let open = 0;
  let allowlist = 0;
  let other = 0;
  for (const value of Object.values(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    const policy = section.groupPolicy;
    if (policy === "open") {
      open += 1;
    } else if (policy === "allowlist") {
      allowlist += 1;
    } else {
      other += 1;
    }
  }
  return { open, allowlist, other };
}

function isProbablySyncedPath(p: string): boolean {
  const s = p.toLowerCase();
  return (
    s.includes("icloud") ||
    s.includes("dropbox") ||
    s.includes("google drive") ||
    s.includes("googledrive") ||
    s.includes("onedrive")
  );
}

function looksLikeEnvRef(value: string): boolean {
  const v = value.trim();
  return v.startsWith("${") && v.endsWith("}");
}

function isGatewayRemotelyExposed(cfg: OpenClawConfig): boolean {
  const bind = typeof cfg.gateway?.bind === "string" ? cfg.gateway.bind : "loopback";
  if (bind !== "loopback") {
    return true;
  }
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  return tailscaleMode === "serve" || tailscaleMode === "funnel";
}

type ModelRef = { id: string; source: string };

function addModel(models: ModelRef[], raw: unknown, source: string) {
  if (typeof raw !== "string") {
    return;
  }
  const id = raw.trim();
  if (!id) {
    return;
  }
  models.push({ id, source });
}

function collectModels(cfg: OpenClawConfig): ModelRef[] {
  const out: ModelRef[] = [];
  addModel(out, cfg.agents?.defaults?.model?.primary, "agents.defaults.model.primary");
  for (const f of cfg.agents?.defaults?.model?.fallbacks ?? []) {
    addModel(out, f, "agents.defaults.model.fallbacks");
  }
  addModel(out, cfg.agents?.defaults?.imageModel?.primary, "agents.defaults.imageModel.primary");
  for (const f of cfg.agents?.defaults?.imageModel?.fallbacks ?? []) {
    addModel(out, f, "agents.defaults.imageModel.fallbacks");
  }

  const list = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  for (const agent of list ?? []) {
    if (!agent || typeof agent !== "object") {
      continue;
    }
    const id =
      typeof (agent as { id?: unknown }).id === "string" ? (agent as { id: string }).id : "";
    const model = (agent as { model?: unknown }).model;
    if (typeof model === "string") {
      addModel(out, model, `agents.list.${id}.model`);
    } else if (model && typeof model === "object") {
      addModel(out, (model as { primary?: unknown }).primary, `agents.list.${id}.model.primary`);
      const fallbacks = (model as { fallbacks?: unknown }).fallbacks;
      if (Array.isArray(fallbacks)) {
        for (const f of fallbacks) {
          addModel(out, f, `agents.list.${id}.model.fallbacks`);
        }
      }
    }
  }
  return out;
}

const LEGACY_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "openai.gpt35", re: /\bgpt-3\.5\b/i, label: "GPT-3.5 family" },
  { id: "anthropic.claude2", re: /\bclaude-(instant|2)\b/i, label: "Claude 2/Instant family" },
  { id: "openai.gpt4_legacy", re: /\bgpt-4-(0314|0613)\b/i, label: "Legacy GPT-4 snapshots" },
];

const WEAK_TIER_MODEL_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  { id: "anthropic.haiku", re: /\bhaiku\b/i, label: "Haiku tier (smaller model)" },
];

function isGptModel(id: string): boolean {
  return /\bgpt-/i.test(id);
}

function isGpt5OrHigher(id: string): boolean {
  return /\bgpt-5(?:\b|[.-])/i.test(id);
}

function isClaudeModel(id: string): boolean {
  return /\bclaude-/i.test(id);
}

function isClaude45OrHigher(id: string): boolean {
  // Match claude-*-4-5+, claude-*-45+, claude-*4.5+, or future 5.x+ majors.
  return /\bclaude-[^\s/]*?(?:-4-?(?:[5-9]|[1-9]\d)\b|4\.(?:[5-9]|[1-9]\d)\b|-[5-9](?:\b|[.-]))/i.test(
    id,
  );
}

function extractAgentIdFromSource(source: string): string | null {
  const match = source.match(/^agents\.list\.([^.]*)\./);
  return match?.[1] ?? null;
}

function hasConfiguredDockerConfig(
  docker: Record<string, unknown> | undefined | null,
): docker is Record<string, unknown> {
  if (!docker || typeof docker !== "object") {
    return false;
  }
  return Object.values(docker).some((value) => value !== undefined);
}

function normalizeNodeCommand(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function listKnownNodeCommands(cfg: OpenClawConfig): Set<string> {
  const baseCfg: OpenClawConfig = {
    ...cfg,
    gateway: {
      ...cfg.gateway,
      nodes: {
        ...cfg.gateway?.nodes,
        denyCommands: [],
      },
    },
  };
  const out = new Set<string>();
  for (const platform of ["ios", "android", "macos", "linux", "windows", "unknown"]) {
    const allow = resolveNodeCommandAllowlist(baseCfg, { platform });
    for (const cmd of allow) {
      const normalized = normalizeNodeCommand(cmd);
      if (normalized) {
        out.add(normalized);
      }
    }
  }
  return out;
}

function looksLikeNodeCommandPattern(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/[?*[\]{}(),|]/.test(value)) {
    return true;
  }
  if (
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith("^") ||
    value.endsWith("$")
  ) {
    return true;
  }
  return /\s/.test(value) || value.includes("group:");
}

function resolveToolPolicies(params: {
  cfg: OpenClawConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profilePolicy = resolveToolProfilePolicy(profile);
  if (profilePolicy) {
    policies.push(profilePolicy);
  }

  const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const agentPolicy = pickSandboxToolPolicy(params.agentTools);
  if (agentPolicy) {
    policies.push(agentPolicy);
  }

  if (params.sandboxMode === "all") {
    const sandboxPolicy = resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined);
    policies.push(sandboxPolicy);
  }

  return policies;
}

function hasWebSearchKey(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const search = cfg.tools?.web?.search;
  return Boolean(
    search?.apiKey ||
    search?.perplexity?.apiKey ||
    env.BRAVE_API_KEY ||
    env.PERPLEXITY_API_KEY ||
    env.OPENROUTER_API_KEY,
  );
}

function isWebSearchEnabled(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  const enabled = cfg.tools?.web?.search?.enabled;
  if (enabled === false) {
    return false;
  }
  if (enabled === true) {
    return true;
  }
  return hasWebSearchKey(cfg, env);
}

function isWebFetchEnabled(cfg: OpenClawConfig): boolean {
  const enabled = cfg.tools?.web?.fetch?.enabled;
  if (enabled === false) {
    return false;
  }
  return true;
}

function isBrowserEnabled(cfg: OpenClawConfig): boolean {
  try {
    return resolveBrowserConfig(cfg.browser, cfg).enabled;
  } catch {
    return true;
  }
}

function listGroupPolicyOpen(cfg: OpenClawConfig): string[] {
  const out: string[] = [];
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels || typeof channels !== "object") {
    return out;
  }
  for (const [channelId, value] of Object.entries(channels)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const section = value as Record<string, unknown>;
    if (section.groupPolicy === "open") {
      out.push(`channels.${channelId}.groupPolicy`);
    }
    const accounts = section.accounts;
    if (accounts && typeof accounts === "object") {
      for (const [accountId, accountVal] of Object.entries(accounts)) {
        if (!accountVal || typeof accountVal !== "object") {
          continue;
        }
        const acc = accountVal as Record<string, unknown>;
        if (acc.groupPolicy === "open") {
          out.push(`channels.${channelId}.accounts.${accountId}.groupPolicy`);
        }
      }
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

export function collectAttackSurfaceSummaryFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const group = summarizeGroupPolicy(cfg);
  const elevated = cfg.tools?.elevated?.enabled !== false;
  const webhooksEnabled = cfg.hooks?.enabled === true;
  const internalHooksEnabled = cfg.hooks?.internal?.enabled === true;
  const browserEnabled = cfg.browser?.enabled ?? true;

  const detail =
    `groups: open=${group.open}, allowlist=${group.allowlist}` +
    `\n` +
    `tools.elevated: ${elevated ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.webhooks: ${webhooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `hooks.internal: ${internalHooksEnabled ? "enabled" : "disabled"}` +
    `\n` +
    `browser control: ${browserEnabled ? "enabled" : "disabled"}`;

  return [
    {
      checkId: "summary.attack_surface",
      severity: "info",
      title: "Attack surface summary",
      detail,
    },
  ];
}

export function collectSyncedFolderFindings(params: {
  stateDir: string;
  configPath: string;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (isProbablySyncedPath(params.stateDir) || isProbablySyncedPath(params.configPath)) {
    findings.push({
      checkId: "fs.synced_dir",
      severity: "warn",
      title: "State/config path looks like a synced folder",
      detail: `stateDir=${params.stateDir}, configPath=${params.configPath}. Synced folders (iCloud/Dropbox/OneDrive/Google Drive) can leak tokens and transcripts onto other devices.`,
      remediation: `Keep OPENCLAW_STATE_DIR on a local-only volume and re-run "${formatCliCommand("openclaw security audit --fix")}".`,
    });
  }
  return findings;
}

export function collectSecretsInConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const password =
    typeof cfg.gateway?.auth?.password === "string" ? cfg.gateway.auth.password.trim() : "";
  if (password && !looksLikeEnvRef(password)) {
    findings.push({
      checkId: "config.secrets.gateway_password_in_config",
      severity: "warn",
      title: "Gateway password is stored in config",
      detail:
        "gateway.auth.password is set in the config file; prefer environment variables for secrets when possible.",
      remediation:
        "Prefer OPENCLAW_GATEWAY_PASSWORD (env) and remove gateway.auth.password from disk.",
    });
  }

  const hooksToken = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (cfg.hooks?.enabled === true && hooksToken && !looksLikeEnvRef(hooksToken)) {
    findings.push({
      checkId: "config.secrets.hooks_token_in_config",
      severity: "info",
      title: "Hooks token is stored in config",
      detail:
        "hooks.token is set in the config file; keep config perms tight and treat it like an API secret.",
    });
  }

  return findings;
}

export function collectHooksHardeningFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.hooks?.enabled !== true) {
    return findings;
  }

  const token = typeof cfg.hooks?.token === "string" ? cfg.hooks.token.trim() : "";
  if (token && token.length < 24) {
    findings.push({
      checkId: "hooks.token_too_short",
      severity: "warn",
      title: "Hooks token looks short",
      detail: `hooks.token is ${token.length} chars; prefer a long random token.`,
    });
  }

  const gatewayAuth = resolveGatewayAuth({
    authConfig: cfg.gateway?.auth,
    tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off",
    env,
  });
  const openclawGatewayToken =
    typeof env.OPENCLAW_GATEWAY_TOKEN === "string" && env.OPENCLAW_GATEWAY_TOKEN.trim()
      ? env.OPENCLAW_GATEWAY_TOKEN.trim()
      : null;
  const gatewayToken =
    gatewayAuth.mode === "token" &&
    typeof gatewayAuth.token === "string" &&
    gatewayAuth.token.trim()
      ? gatewayAuth.token.trim()
      : openclawGatewayToken
        ? openclawGatewayToken
        : null;
  if (token && gatewayToken && token === gatewayToken) {
    findings.push({
      checkId: "hooks.token_reuse_gateway_token",
      severity: "critical",
      title: "Hooks token reuses the Gateway token",
      detail:
        "hooks.token matches gateway.auth token; compromise of hooks expands blast radius to the Gateway API.",
      remediation: "Use a separate hooks.token dedicated to hook ingress.",
    });
  }

  const rawPath = typeof cfg.hooks?.path === "string" ? cfg.hooks.path.trim() : "";
  if (rawPath === "/") {
    findings.push({
      checkId: "hooks.path_root",
      severity: "critical",
      title: "Hooks base path is '/'",
      detail: "hooks.path='/' would shadow other HTTP endpoints and is unsafe.",
      remediation: "Use a dedicated path like '/hooks'.",
    });
  }

  const allowRequestSessionKey = cfg.hooks?.allowRequestSessionKey === true;
  const defaultSessionKey =
    typeof cfg.hooks?.defaultSessionKey === "string" ? cfg.hooks.defaultSessionKey.trim() : "";
  const allowedPrefixes = Array.isArray(cfg.hooks?.allowedSessionKeyPrefixes)
    ? cfg.hooks.allowedSessionKeyPrefixes
        .map((prefix) => prefix.trim())
        .filter((prefix) => prefix.length > 0)
    : [];
  const remoteExposure = isGatewayRemotelyExposed(cfg);

  if (!defaultSessionKey) {
    findings.push({
      checkId: "hooks.default_session_key_unset",
      severity: "warn",
      title: "hooks.defaultSessionKey is not configured",
      detail:
        "Hook agent runs without explicit sessionKey use generated per-request keys. Set hooks.defaultSessionKey to keep hook ingress scoped to a known session.",
      remediation: 'Set hooks.defaultSessionKey (for example, "hook:ingress").',
    });
  }

  if (allowRequestSessionKey) {
    findings.push({
      checkId: "hooks.request_session_key_enabled",
      severity: remoteExposure ? "critical" : "warn",
      title: "External hook payloads may override sessionKey",
      detail:
        "hooks.allowRequestSessionKey=true allows `/hooks/agent` callers to choose the session key. Treat hook token holders as full-trust unless you also restrict prefixes.",
      remediation:
        "Set hooks.allowRequestSessionKey=false (recommended) or constrain hooks.allowedSessionKeyPrefixes.",
    });
  }

  if (allowRequestSessionKey && allowedPrefixes.length === 0) {
    findings.push({
      checkId: "hooks.request_session_key_prefixes_missing",
      severity: remoteExposure ? "critical" : "warn",
      title: "Request sessionKey override is enabled without prefix restrictions",
      detail:
        "hooks.allowRequestSessionKey=true and hooks.allowedSessionKeyPrefixes is unset/empty, so request payloads can target arbitrary session key shapes.",
      remediation:
        'Set hooks.allowedSessionKeyPrefixes (for example, ["hook:"]) or disable request overrides.',
    });
  }

  return findings;
}

export function collectGatewayHttpSessionKeyOverrideFindings(
  cfg: OpenClawConfig,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
  if (!chatCompletionsEnabled && !responsesEnabled) {
    return findings;
  }

  const enabledEndpoints = [
    chatCompletionsEnabled ? "/v1/chat/completions" : null,
    responsesEnabled ? "/v1/responses" : null,
  ].filter((entry): entry is string => Boolean(entry));

  findings.push({
    checkId: "gateway.http.session_key_override_enabled",
    severity: "info",
    title: "HTTP API session-key override is enabled",
    detail:
      `${enabledEndpoints.join(", ")} accept x-openclaw-session-key for per-request session routing. ` +
      "Treat API credential holders as trusted principals.",
  });

  return findings;
}

export function collectGatewayHttpNoAuthFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const tailscaleMode = cfg.gateway?.tailscale?.mode ?? "off";
  const auth = resolveGatewayAuth({ authConfig: cfg.gateway?.auth, tailscaleMode, env });
  if (auth.mode !== "none") {
    return findings;
  }

  const chatCompletionsEnabled = cfg.gateway?.http?.endpoints?.chatCompletions?.enabled === true;
  const responsesEnabled = cfg.gateway?.http?.endpoints?.responses?.enabled === true;
  const enabledEndpoints = [
    "/tools/invoke",
    chatCompletionsEnabled ? "/v1/chat/completions" : null,
    responsesEnabled ? "/v1/responses" : null,
  ].filter((entry): entry is string => Boolean(entry));

  const remoteExposure = isGatewayRemotelyExposed(cfg);
  findings.push({
    checkId: "gateway.http.no_auth",
    severity: remoteExposure ? "critical" : "warn",
    title: "Gateway HTTP APIs are reachable without auth",
    detail:
      `gateway.auth.mode="none" leaves ${enabledEndpoints.join(", ")} callable without a shared secret. ` +
      "Treat this as trusted-local only and avoid exposing the gateway beyond loopback.",
    remediation:
      "Set gateway.auth.mode to token/password (recommended). If you intentionally keep mode=none, keep gateway.bind=loopback and disable optional HTTP endpoints.",
  });

  return findings;
}

export function collectSandboxDockerNoopFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const configuredPaths: string[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

  const defaultsSandbox = cfg.agents?.defaults?.sandbox;
  const hasDefaultDocker = hasConfiguredDockerConfig(
    defaultsSandbox?.docker as Record<string, unknown> | undefined,
  );
  const defaultMode = defaultsSandbox?.mode ?? "off";
  const hasAnySandboxEnabledAgent = agents.some((entry) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      return false;
    }
    return resolveSandboxConfigForAgent(cfg, entry.id).mode !== "off";
  });
  if (hasDefaultDocker && defaultMode === "off" && !hasAnySandboxEnabledAgent) {
    configuredPaths.push("agents.defaults.sandbox.docker");
  }

  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    if (!hasConfiguredDockerConfig(entry.sandbox?.docker as Record<string, unknown> | undefined)) {
      continue;
    }
    if (resolveSandboxConfigForAgent(cfg, entry.id).mode === "off") {
      configuredPaths.push(`agents.list.${entry.id}.sandbox.docker`);
    }
  }

  if (configuredPaths.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "sandbox.docker_config_mode_off",
    severity: "warn",
    title: "Sandbox docker settings configured while sandbox mode is off",
    detail:
      "These docker settings will not take effect until sandbox mode is enabled:\n" +
      configuredPaths.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      'Enable sandbox mode (`agents.defaults.sandbox.mode="non-main"` or `"all"`) where needed, or remove unused docker settings.',
  });

  return findings;
}

export function collectSandboxDangerousConfigFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];

  const configs: Array<{ source: string; docker: Record<string, unknown> }> = [];
  const defaultDocker = cfg.agents?.defaults?.sandbox?.docker;
  if (defaultDocker && typeof defaultDocker === "object") {
    configs.push({
      source: "agents.defaults.sandbox.docker",
      docker: defaultDocker as Record<string, unknown>,
    });
  }
  for (const entry of agents) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string") {
      continue;
    }
    const agentDocker = entry.sandbox?.docker;
    if (agentDocker && typeof agentDocker === "object") {
      configs.push({
        source: `agents.list.${entry.id}.sandbox.docker`,
        docker: agentDocker as Record<string, unknown>,
      });
    }
  }

  for (const { source, docker } of configs) {
    const binds = Array.isArray(docker.binds) ? docker.binds : [];
    for (const bind of binds) {
      if (typeof bind !== "string") {
        continue;
      }
      const blocked = getBlockedBindReason(bind);
      if (!blocked) {
        continue;
      }
      if (blocked.kind === "non_absolute") {
        findings.push({
          checkId: "sandbox.bind_mount_non_absolute",
          severity: "warn",
          title: "Sandbox bind mount uses a non-absolute source path",
          detail:
            `${source}.binds contains "${bind}" which uses source path "${blocked.sourcePath}". ` +
            "Non-absolute bind sources are hard to validate safely and may resolve unexpectedly.",
          remediation: `Rewrite "${bind}" to use an absolute host path (for example: /home/user/project:/project:ro).`,
        });
        continue;
      }
      const verb = blocked.kind === "covers" ? "covers" : "targets";
      findings.push({
        checkId: "sandbox.dangerous_bind_mount",
        severity: "critical",
        title: "Dangerous bind mount in sandbox config",
        detail:
          `${source}.binds contains "${bind}" which ${verb} blocked path "${blocked.blockedPath}". ` +
          "This can expose host system directories or the Docker socket to sandbox containers.",
        remediation: `Remove "${bind}" from ${source}.binds. Use project-specific paths instead.`,
      });
    }

    const network = typeof docker.network === "string" ? docker.network : undefined;
    if (network && network.trim().toLowerCase() === "host") {
      findings.push({
        checkId: "sandbox.dangerous_network_mode",
        severity: "critical",
        title: "Network host mode in sandbox config",
        detail: `${source}.network is "host" which bypasses container network isolation entirely.`,
        remediation: `Set ${source}.network to "bridge" or "none".`,
      });
    }

    const seccompProfile =
      typeof docker.seccompProfile === "string" ? docker.seccompProfile : undefined;
    if (seccompProfile && seccompProfile.trim().toLowerCase() === "unconfined") {
      findings.push({
        checkId: "sandbox.dangerous_seccomp_profile",
        severity: "critical",
        title: "Seccomp unconfined in sandbox config",
        detail: `${source}.seccompProfile is "unconfined" which disables syscall filtering.`,
        remediation: `Remove ${source}.seccompProfile or use a custom seccomp profile file.`,
      });
    }

    const apparmorProfile =
      typeof docker.apparmorProfile === "string" ? docker.apparmorProfile : undefined;
    if (apparmorProfile && apparmorProfile.trim().toLowerCase() === "unconfined") {
      findings.push({
        checkId: "sandbox.dangerous_apparmor_profile",
        severity: "critical",
        title: "AppArmor unconfined in sandbox config",
        detail: `${source}.apparmorProfile is "unconfined" which disables AppArmor enforcement.`,
        remediation: `Remove ${source}.apparmorProfile or use a named AppArmor profile.`,
      });
    }
  }

  return findings;
}

export function collectNodeDenyCommandPatternFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const denyListRaw = cfg.gateway?.nodes?.denyCommands;
  if (!Array.isArray(denyListRaw) || denyListRaw.length === 0) {
    return findings;
  }

  const denyList = denyListRaw.map(normalizeNodeCommand).filter(Boolean);
  if (denyList.length === 0) {
    return findings;
  }

  const knownCommands = listKnownNodeCommands(cfg);
  const patternLike = denyList.filter((entry) => looksLikeNodeCommandPattern(entry));
  const unknownExact = denyList.filter(
    (entry) => !looksLikeNodeCommandPattern(entry) && !knownCommands.has(entry),
  );
  if (patternLike.length === 0 && unknownExact.length === 0) {
    return findings;
  }

  const detailParts: string[] = [];
  if (patternLike.length > 0) {
    detailParts.push(
      `Pattern-like entries (not supported by exact matching): ${patternLike.join(", ")}`,
    );
  }
  if (unknownExact.length > 0) {
    detailParts.push(
      `Unknown command names (not in defaults/allowCommands): ${unknownExact.join(", ")}`,
    );
  }
  const examples = Array.from(knownCommands).slice(0, 8);

  findings.push({
    checkId: "gateway.nodes.deny_commands_ineffective",
    severity: "warn",
    title: "Some gateway.nodes.denyCommands entries are ineffective",
    detail:
      "gateway.nodes.denyCommands uses exact command-name matching only.\n" +
      detailParts.map((entry) => `- ${entry}`).join("\n"),
    remediation:
      `Use exact command names (for example: ${examples.join(", ")}). ` +
      "If you need broader restrictions, remove risky commands from allowCommands/default workflows.",
  });

  return findings;
}

export function collectMinimalProfileOverrideFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  if (cfg.tools?.profile !== "minimal") {
    return findings;
  }

  const overrides = (cfg.agents?.list ?? [])
    .filter((entry): entry is { id: string; tools?: AgentToolsConfig } => {
      return Boolean(
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        entry.tools?.profile &&
        entry.tools.profile !== "minimal",
      );
    })
    .map((entry) => `${entry.id}=${entry.tools?.profile}`);

  if (overrides.length === 0) {
    return findings;
  }

  findings.push({
    checkId: "tools.profile_minimal_overridden",
    severity: "warn",
    title: "Global tools.profile=minimal is overridden by agent profiles",
    detail:
      "Global minimal profile is set, but these agent profiles take precedence:\n" +
      overrides.map((entry) => `- agents.list.${entry}`).join("\n"),
    remediation:
      'Set those agents to `tools.profile="minimal"` (or remove the agent override) if you want minimal tools enforced globally.',
  });

  return findings;
}

export function collectModelHygieneFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(cfg);
  if (models.length === 0) {
    return findings;
  }

  const weakMatches = new Map<string, { model: string; source: string; reasons: string[] }>();
  const addWeakMatch = (model: string, source: string, reason: string) => {
    const key = `${model}@@${source}`;
    const existing = weakMatches.get(key);
    if (!existing) {
      weakMatches.set(key, { model, source, reasons: [reason] });
      return;
    }
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
  };

  for (const entry of models) {
    for (const pat of WEAK_TIER_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        addWeakMatch(entry.id, entry.source, pat.label);
        break;
      }
    }
    if (isGptModel(entry.id) && !isGpt5OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below GPT-5 family");
    }
    if (isClaudeModel(entry.id) && !isClaude45OrHigher(entry.id)) {
      addWeakMatch(entry.id, entry.source, "Below Claude 4.5");
    }
  }

  const matches: Array<{ model: string; source: string; reason: string }> = [];
  for (const entry of models) {
    for (const pat of LEGACY_MODEL_PATTERNS) {
      if (pat.re.test(entry.id)) {
        matches.push({ model: entry.id, source: entry.source, reason: pat.label });
        break;
      }
    }
  }

  if (matches.length > 0) {
    const lines = matches
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reason}) @ ${m.source}`)
      .join("\n");
    const more = matches.length > 12 ? `\n…${matches.length - 12} more` : "";
    findings.push({
      checkId: "models.legacy",
      severity: "warn",
      title: "Some configured models look legacy",
      detail:
        "Older/legacy models can be less robust against prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation: "Prefer modern, instruction-hardened models for any bot that can run tools.",
    });
  }

  if (weakMatches.size > 0) {
    const lines = Array.from(weakMatches.values())
      .slice(0, 12)
      .map((m) => `- ${m.model} (${m.reasons.join("; ")}) @ ${m.source}`)
      .join("\n");
    const more = weakMatches.size > 12 ? `\n…${weakMatches.size - 12} more` : "";
    findings.push({
      checkId: "models.weak_tier",
      severity: "warn",
      title: "Some configured models are below recommended tiers",
      detail:
        "Smaller/older models are generally more susceptible to prompt injection and tool misuse.\n" +
        lines +
        more,
      remediation:
        "Use the latest, top-tier model for any bot with tools or untrusted inboxes. Avoid Haiku tiers; prefer GPT-5+ and Claude 4.5+.",
    });
  }

  return findings;
}

export function collectSmallModelRiskFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const models = collectModels(params.cfg).filter((entry) => !entry.source.includes("imageModel"));
  if (models.length === 0) {
    return findings;
  }

  const smallModels = models
    .map((entry) => {
      const paramB = inferParamBFromIdOrName(entry.id);
      if (!paramB || paramB > SMALL_MODEL_PARAM_B_MAX) {
        return null;
      }
      return { ...entry, paramB };
    })
    .filter((entry): entry is { id: string; source: string; paramB: number } => Boolean(entry));

  if (smallModels.length === 0) {
    return findings;
  }

  let hasUnsafe = false;
  const modelLines: string[] = [];
  const exposureSet = new Set<string>();
  for (const entry of smallModels) {
    const agentId = extractAgentIdFromSource(entry.source);
    const sandboxMode = resolveSandboxConfigForAgent(params.cfg, agentId ?? undefined).mode;
    const agentTools =
      agentId && params.cfg.agents?.list
        ? params.cfg.agents.list.find((agent) => agent?.id === agentId)?.tools
        : undefined;
    const policies = resolveToolPolicies({
      cfg: params.cfg,
      agentTools,
      sandboxMode,
      agentId,
    });
    const exposed: string[] = [];
    if (isWebSearchEnabled(params.cfg, params.env)) {
      if (isToolAllowedByPolicies("web_search", policies)) {
        exposed.push("web_search");
      }
    }
    if (isWebFetchEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("web_fetch", policies)) {
        exposed.push("web_fetch");
      }
    }
    if (isBrowserEnabled(params.cfg)) {
      if (isToolAllowedByPolicies("browser", policies)) {
        exposed.push("browser");
      }
    }
    for (const tool of exposed) {
      exposureSet.add(tool);
    }
    const sandboxLabel = sandboxMode === "all" ? "sandbox=all" : `sandbox=${sandboxMode}`;
    const exposureLabel = exposed.length > 0 ? ` web=[${exposed.join(", ")}]` : " web=[off]";
    const safe = sandboxMode === "all" && exposed.length === 0;
    if (!safe) {
      hasUnsafe = true;
    }
    const statusLabel = safe ? "ok" : "unsafe";
    modelLines.push(
      `- ${entry.id} (${entry.paramB}B) @ ${entry.source} (${statusLabel}; ${sandboxLabel};${exposureLabel})`,
    );
  }

  const exposureList = Array.from(exposureSet);
  const exposureDetail =
    exposureList.length > 0
      ? `Uncontrolled input tools allowed: ${exposureList.join(", ")}.`
      : "No web/browser tools detected for these models.";

  findings.push({
    checkId: "models.small_params",
    severity: hasUnsafe ? "critical" : "info",
    title: "Small models require sandboxing and web tools disabled",
    detail:
      `Small models (<=${SMALL_MODEL_PARAM_B_MAX}B params) detected:\n` +
      modelLines.join("\n") +
      `\n` +
      exposureDetail +
      `\n` +
      "Small models are not recommended for untrusted inputs.",
    remediation:
      'If you must use small models, enable sandboxing for all sessions (agents.defaults.sandbox.mode="all") and disable web_search/web_fetch/browser (tools.deny=["group:web","browser"]).',
  });

  return findings;
}

export function collectExposureMatrixFindings(cfg: OpenClawConfig): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const openGroups = listGroupPolicyOpen(cfg);
  if (openGroups.length === 0) {
    return findings;
  }

  const elevatedEnabled = cfg.tools?.elevated?.enabled !== false;
  if (elevatedEnabled) {
    findings.push({
      checkId: "security.exposure.open_groups_with_elevated",
      severity: "critical",
      title: "Open groupPolicy with elevated tools enabled",
      detail:
        `Found groupPolicy="open" at:\n${openGroups.map((p) => `- ${p}`).join("\n")}\n` +
        "With tools.elevated enabled, a prompt injection in those rooms can become a high-impact incident.",
      remediation: `Set groupPolicy="allowlist" and keep elevated allowlists extremely tight.`,
    });
  }

  return findings;
}
