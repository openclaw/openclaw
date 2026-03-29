import { resolveAgentConfig } from "../agents/agent-scope.js";
import {
  resolveSandboxConfigForAgent,
  resolveSandboxToolPolicyForAgent,
} from "../agents/sandbox.js";
import { resolveElevatedChannelFallbackAllowFrom } from "../auto-reply/reply/reply-elevated.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveMainSessionKey,
  resolveStorePath,
} from "../config/sessions.js";
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { type RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";

type SandboxExplainOptions = {
  session?: string;
  agent?: string;
  json: boolean;
};

const SANDBOX_DOCS_URL = "https://docs.openclaw.ai/sandbox";

function normalizeExplainSessionKey(params: {
  cfg: OpenClawConfig;
  agentId: string;
  session?: string;
}): string {
  const raw = (params.session ?? "").trim();
  if (!raw) {
    return resolveAgentMainSessionKey({
      cfg: params.cfg,
      agentId: params.agentId,
    });
  }
  if (raw.includes(":")) {
    return raw;
  }
  if (raw === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: normalizeMainKey(raw),
  });
}

function inferProviderFromSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) {
    return undefined;
  }
  const rest = parsed.rest.trim();
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  if (parts.length === 0) {
    return undefined;
  }
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (parts[0] === configuredMainKey) {
    return undefined;
  }
  const candidate = parts[0]?.trim().toLowerCase();
  if (!candidate) {
    return undefined;
  }
  if (candidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  return normalizeAnyChannelId(candidate) ?? candidate;
}

function inferAccountIdFromSessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): string | undefined {
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed) {
    return undefined;
  }
  const rest = parsed.rest.trim();
  if (!rest) {
    return undefined;
  }
  const parts = rest.split(":").filter(Boolean);
  if (parts.length < 4) {
    return undefined;
  }
  const configuredMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (parts[0] === configuredMainKey) {
    return undefined;
  }
  const peerKind = parts[2]?.trim().toLowerCase();
  if (peerKind !== "direct") {
    return undefined;
  }
  const accountId = parts[1]?.trim();
  return accountId || undefined;
}

function resolveActiveChannel(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
}): string | undefined {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId,
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey] as
    | {
        lastChannel?: string;
        channel?: string;
        // Legacy keys (pre-rename).
        lastProvider?: string;
        provider?: string;
      }
    | undefined;
  const candidate = (
    entry?.lastChannel ??
    entry?.channel ??
    entry?.lastProvider ??
    entry?.provider ??
    ""
  )
    .trim()
    .toLowerCase();
  if (candidate === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const normalized = normalizeAnyChannelId(candidate);
  if (normalized) {
    return normalized;
  }
  if (candidate) {
    return candidate;
  }
  return inferProviderFromSessionKey({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
}

export async function sandboxExplainCommand(
  opts: SandboxExplainOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  const cfg = loadConfig();

  const defaultAgentId = resolveAgentIdFromSessionKey(resolveMainSessionKey(cfg));
  const resolvedAgentId = normalizeAgentId(
    opts.agent?.trim()
      ? opts.agent
      : opts.session?.trim()
        ? resolveAgentIdFromSessionKey(opts.session)
        : defaultAgentId,
  );

  const sessionKey = normalizeExplainSessionKey({
    cfg,
    agentId: resolvedAgentId,
    session: opts.session,
  });

  const sandboxCfg = resolveSandboxConfigForAgent(cfg, resolvedAgentId);
  const toolPolicy = resolveSandboxToolPolicyForAgent(cfg, resolvedAgentId);
  const mainSessionKey = resolveAgentMainSessionKey({
    cfg,
    agentId: resolvedAgentId,
  });
  const sessionIsSandboxed =
    sandboxCfg.mode === "all"
      ? true
      : sandboxCfg.mode === "off"
        ? false
        : sessionKey.trim() !== mainSessionKey.trim();

  const channel = resolveActiveChannel({
    cfg,
    agentId: resolvedAgentId,
    sessionKey,
  });
  const accountId = inferAccountIdFromSessionKey({
    cfg,
    sessionKey,
  });

  const agentConfig = resolveAgentConfig(cfg, resolvedAgentId);
  const elevatedGlobal = cfg.tools?.elevated;
  const elevatedAgent = agentConfig?.tools?.elevated;
  const elevatedGlobalEnabled = elevatedGlobal?.enabled !== false;
  const elevatedAgentEnabled = elevatedAgent?.enabled !== false;
  const elevatedEnabled = elevatedGlobalEnabled && elevatedAgentEnabled;

  const globalAllow = channel ? elevatedGlobal?.allowFrom?.[channel] : undefined;
  const globalFallbackAllow = channel
    ? resolveElevatedChannelFallbackAllowFrom({
        cfg,
        provider: channel,
        accountId,
      })
    : undefined;
  const effectiveGlobalAllow = globalAllow ?? globalFallbackAllow;
  const agentAllow = channel ? elevatedAgent?.allowFrom?.[channel] : undefined;

  const allowTokens = (values?: Array<string | number>) =>
    (values ?? []).map((v) => String(v).trim()).filter(Boolean);
  const globalAllowTokens = allowTokens(effectiveGlobalAllow);
  const agentAllowTokens = allowTokens(agentAllow);

  const elevatedAllowedByConfig =
    elevatedEnabled &&
    Boolean(channel) &&
    globalAllowTokens.length > 0 &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.length > 0 : true);

  const elevatedAlwaysAllowedByConfig =
    elevatedAllowedByConfig &&
    globalAllowTokens.includes("*") &&
    (elevatedAgent?.allowFrom ? agentAllowTokens.includes("*") : true);

  const elevatedFailures: Array<{ gate: string; key: string }> = [];
  if (!elevatedGlobalEnabled) {
    elevatedFailures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!elevatedAgentEnabled) {
    elevatedFailures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  }
  if (channel && globalAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${channel}`,
    });
  }
  if (channel && elevatedAgent?.allowFrom && agentAllowTokens.length === 0) {
    elevatedFailures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${channel}`,
    });
  }

  const fixIt: string[] = [];
  if (sandboxCfg.mode !== "off") {
    fixIt.push("agents.defaults.sandbox.mode=off");
    fixIt.push("agents.list[].sandbox.mode=off");
  }
  fixIt.push("tools.sandbox.tools.allow");
  fixIt.push("tools.sandbox.tools.alsoAllow");
  fixIt.push("tools.sandbox.tools.deny");
  fixIt.push("agents.list[].tools.sandbox.tools.allow");
  fixIt.push("agents.list[].tools.sandbox.tools.alsoAllow");
  fixIt.push("agents.list[].tools.sandbox.tools.deny");
  fixIt.push("tools.elevated.enabled");
  if (channel) {
    fixIt.push(`tools.elevated.allowFrom.${channel}`);
  }

  const payload = {
    docsUrl: SANDBOX_DOCS_URL,
    agentId: resolvedAgentId,
    sessionKey,
    mainSessionKey,
    sandbox: {
      mode: sandboxCfg.mode,
      scope: sandboxCfg.scope,
      perSession: sandboxCfg.scope === "session",
      workspaceAccess: sandboxCfg.workspaceAccess,
      workspaceRoot: sandboxCfg.workspaceRoot,
      sessionIsSandboxed,
      tools: {
        allow: toolPolicy.allow,
        deny: toolPolicy.deny,
        sources: toolPolicy.sources,
      },
    },
    elevated: {
      enabled: elevatedEnabled,
      channel,
      accountId,
      allowedByConfig: elevatedAllowedByConfig,
      alwaysAllowedByConfig: elevatedAlwaysAllowedByConfig,
      allowFrom: {
        global: effectiveGlobalAllow,
        agent: agentAllow,
      },
      failures: elevatedFailures,
    },
    fixIt,
  };

  if (opts.json) {
    runtime.log(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const rich = isRich();
  const title = colorize(rich, theme.accent, "Sandbox explain");
  const lines = [
    title,
    `Agent: ${resolvedAgentId}`,
    `Session: ${sessionKey}`,
    `Sandbox: mode=${sandboxCfg.mode} scope=${sandboxCfg.scope} workspace=${sandboxCfg.workspaceAccess}`,
    `Session sandboxed: ${sessionIsSandboxed ? "yes" : "no"}`,
    `Allow tools: ${toolPolicy.allow.join(", ") || "(none)"}`,
    `Deny tools: ${toolPolicy.deny.join(", ") || "(none)"}`,
    `Elevated enabled: ${elevatedEnabled ? "yes" : "no"}`,
    `Elevated channel: ${channel ?? "(unknown)"}`,
    `Elevated account: ${accountId ?? "(unknown)"}`,
    `Elevated allowedByConfig: ${elevatedAllowedByConfig ? "yes" : "no"}`,
  ];
  if (elevatedFailures.length > 0) {
    lines.push(`Elevated failures: ${elevatedFailures.map((failure) => failure.key).join(", ")}`);
  }
  if (fixIt.length > 0) {
    lines.push(`Fix-it: ${fixIt.join(", ")}`);
  }
  lines.push(`Docs: ${formatDocsLink(SANDBOX_DOCS_URL)}`);
  runtime.log(`${lines.join("\n")}\n`);
}
