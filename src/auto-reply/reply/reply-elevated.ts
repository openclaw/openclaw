import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelDock } from "../../channels/dock.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import { CHAT_CHANNEL_ORDER } from "../../channels/registry.js";
import type { AgentElevatedAllowFromConfig, OpenClawConfig } from "../../config/config.js";
import { normalizeAtHashSlug } from "../../shared/string-normalization.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { MsgContext } from "../templating.js";
export { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";

type ExplicitElevatedAllowField = "id" | "from" | "e164" | "name" | "username" | "tag";

const EXPLICIT_ELEVATED_ALLOW_FIELDS = new Set<ExplicitElevatedAllowField>([
  "id",
  "from",
  "e164",
  "name",
  "username",
  "tag",
]);

function normalizeAllowToken(value?: string) {
  if (!value) {
    return "";
  }
  return value.trim().toLowerCase();
}

function slugAllowToken(value?: string) {
  return normalizeAtHashSlug(value);
}

const SENDER_PREFIXES = [
  ...CHAT_CHANNEL_ORDER,
  INTERNAL_MESSAGE_CHANNEL,
  "user",
  "group",
  "channel",
];
const SENDER_PREFIX_RE = new RegExp(`^(${SENDER_PREFIXES.join("|")}):`, "i");

function stripSenderPrefix(value?: string) {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.replace(SENDER_PREFIX_RE, "");
}

function resolveElevatedAllowList(
  allowFrom: AgentElevatedAllowFromConfig | undefined,
  provider: string,
  fallbackAllowFrom?: Array<string | number>,
): Array<string | number> | undefined {
  if (!allowFrom) {
    return fallbackAllowFrom;
  }
  const value = allowFrom[provider];
  return Array.isArray(value) ? value : fallbackAllowFrom;
}

function parseExplicitElevatedAllowEntry(
  entry: string,
): { field: ExplicitElevatedAllowField; value: string } | null {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const fieldRaw = entry.slice(0, separatorIndex).trim().toLowerCase();
  if (!EXPLICIT_ELEVATED_ALLOW_FIELDS.has(fieldRaw as ExplicitElevatedAllowField)) {
    return null;
  }
  const value = entry.slice(separatorIndex + 1).trim();
  if (!value) {
    return null;
  }
  return {
    field: fieldRaw as ExplicitElevatedAllowField,
    value,
  };
}

function addTokenVariants(tokens: Set<string>, value: string) {
  if (!value) {
    return;
  }
  tokens.add(value);
  const normalized = normalizeAllowToken(value);
  if (normalized) {
    tokens.add(normalized);
  }
}

function addProviderFormattedTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  accountId?: string;
  values: string[];
  tokens: Set<string>;
}) {
  const normalizedProvider = normalizeChannelId(params.provider);
  const dock = normalizedProvider ? getChannelDock(normalizedProvider) : undefined;
  const formatted = dock?.config?.formatAllowFrom
    ? dock.config.formatAllowFrom({
        cfg: params.cfg,
        accountId: params.accountId,
        allowFrom: params.values,
      })
    : params.values.map((entry) => String(entry).trim()).filter(Boolean);
  for (const entry of formatted) {
    addTokenVariants(params.tokens, entry);
  }
}

function matchesProviderFormattedTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  accountId?: string;
  value: string;
  includeStripped?: boolean;
  tokens: Set<string>;
}): boolean {
  const probeTokens = new Set<string>();
  const values = params.includeStripped
    ? [params.value, stripSenderPrefix(params.value)].filter(Boolean)
    : [params.value];
  addProviderFormattedTokens({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.accountId,
    values,
    tokens: probeTokens,
  });
  for (const token of probeTokens) {
    if (params.tokens.has(token)) {
      return true;
    }
  }
  return false;
}

function buildMutableTokens(value?: string): Set<string> {
  const tokens = new Set<string>();
  const trimmed = value?.trim();
  if (!trimmed) {
    return tokens;
  }
  addTokenVariants(tokens, trimmed);
  const slugged = slugAllowToken(trimmed);
  if (slugged) {
    addTokenVariants(tokens, slugged);
  }
  return tokens;
}

function matchesMutableTokens(value: string, tokens: Set<string>): boolean {
  if (!value || tokens.size === 0) {
    return false;
  }
  const probes = new Set<string>();
  addTokenVariants(probes, value);
  const slugged = slugAllowToken(value);
  if (slugged) {
    addTokenVariants(probes, slugged);
  }
  for (const probe of probes) {
    if (tokens.has(probe)) {
      return true;
    }
  }
  return false;
}

function isApprovedElevatedSender(params: {
  cfg: OpenClawConfig;
  provider: string;
  ctx: MsgContext;
  allowFrom?: AgentElevatedAllowFromConfig;
  fallbackAllowFrom?: Array<string | number>;
}): boolean {
  const rawAllow = resolveElevatedAllowList(
    params.allowFrom,
    params.provider,
    params.fallbackAllowFrom,
  );
  if (!rawAllow || rawAllow.length === 0) {
    return false;
  }

  const allowTokens = rawAllow.map((entry) => String(entry).trim()).filter(Boolean);
  if (allowTokens.length === 0) {
    return false;
  }
  if (allowTokens.some((entry) => entry === "*")) {
    return true;
  }

  const senderIdTokens = new Set<string>();
  const senderFromTokens = new Set<string>();
  const senderE164Tokens = new Set<string>();

  if (params.ctx.SenderId?.trim()) {
    addProviderFormattedTokens({
      cfg: params.cfg,
      provider: params.provider,
      accountId: params.ctx.AccountId,
      values: [params.ctx.SenderId, stripSenderPrefix(params.ctx.SenderId)].filter(Boolean),
      tokens: senderIdTokens,
    });
  }
  if (params.ctx.From?.trim()) {
    addProviderFormattedTokens({
      cfg: params.cfg,
      provider: params.provider,
      accountId: params.ctx.AccountId,
      values: [params.ctx.From, stripSenderPrefix(params.ctx.From)].filter(Boolean),
      tokens: senderFromTokens,
    });
  }
  if (params.ctx.SenderE164?.trim()) {
    addProviderFormattedTokens({
      cfg: params.cfg,
      provider: params.provider,
      accountId: params.ctx.AccountId,
      values: [params.ctx.SenderE164],
      tokens: senderE164Tokens,
    });
  }
  const senderIdentityTokens = new Set<string>([
    ...senderIdTokens,
    ...senderFromTokens,
    ...senderE164Tokens,
  ]);

  const senderNameTokens = buildMutableTokens(params.ctx.SenderName);
  const senderUsernameTokens = buildMutableTokens(params.ctx.SenderUsername);
  const senderTagTokens = buildMutableTokens(params.ctx.SenderTag);

  for (const entry of allowTokens) {
    const explicitEntry = parseExplicitElevatedAllowEntry(entry);
    if (!explicitEntry) {
      if (
        matchesProviderFormattedTokens({
          cfg: params.cfg,
          provider: params.provider,
          accountId: params.ctx.AccountId,
          value: entry,
          includeStripped: true,
          tokens: senderIdentityTokens,
        })
      ) {
        return true;
      }
      continue;
    }
    if (explicitEntry.field === "id") {
      if (
        matchesProviderFormattedTokens({
          cfg: params.cfg,
          provider: params.provider,
          accountId: params.ctx.AccountId,
          value: explicitEntry.value,
          includeStripped: true,
          tokens: senderIdTokens,
        })
      ) {
        return true;
      }
      continue;
    }
    if (explicitEntry.field === "from") {
      if (
        matchesProviderFormattedTokens({
          cfg: params.cfg,
          provider: params.provider,
          accountId: params.ctx.AccountId,
          value: explicitEntry.value,
          includeStripped: true,
          tokens: senderFromTokens,
        })
      ) {
        return true;
      }
      continue;
    }
    if (explicitEntry.field === "e164") {
      if (
        matchesProviderFormattedTokens({
          cfg: params.cfg,
          provider: params.provider,
          accountId: params.ctx.AccountId,
          value: explicitEntry.value,
          tokens: senderE164Tokens,
        })
      ) {
        return true;
      }
      continue;
    }
    if (explicitEntry.field === "name") {
      if (matchesMutableTokens(explicitEntry.value, senderNameTokens)) {
        return true;
      }
      continue;
    }
    if (explicitEntry.field === "username") {
      if (matchesMutableTokens(explicitEntry.value, senderUsernameTokens)) {
        return true;
      }
      continue;
    }
    if (
      explicitEntry.field === "tag" &&
      matchesMutableTokens(explicitEntry.value, senderTagTokens)
    ) {
      return true;
    }
  }

  return false;
}

export function resolveElevatedPermissions(params: {
  cfg: OpenClawConfig;
  agentId: string;
  ctx: MsgContext;
  provider: string;
}): {
  enabled: boolean;
  allowed: boolean;
  failures: Array<{ gate: string; key: string }>;
} {
  const globalConfig = params.cfg.tools?.elevated;
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools?.elevated;
  const globalEnabled = globalConfig?.enabled !== false;
  const agentEnabled = agentConfig?.enabled !== false;
  const enabled = globalEnabled && agentEnabled;
  const failures: Array<{ gate: string; key: string }> = [];
  if (!globalEnabled) {
    failures.push({ gate: "enabled", key: "tools.elevated.enabled" });
  }
  if (!agentEnabled) {
    failures.push({
      gate: "enabled",
      key: "agents.list[].tools.elevated.enabled",
    });
  }
  if (!enabled) {
    return { enabled, allowed: false, failures };
  }
  if (!params.provider) {
    failures.push({ gate: "provider", key: "ctx.Provider" });
    return { enabled, allowed: false, failures };
  }

  const normalizedProvider = normalizeChannelId(params.provider);
  const dockFallbackAllowFrom = normalizedProvider
    ? getChannelDock(normalizedProvider)?.elevated?.allowFromFallback?.({
        cfg: params.cfg,
        accountId: params.ctx.AccountId,
      })
    : undefined;
  const fallbackAllowFrom = dockFallbackAllowFrom;
  const globalAllowed = isApprovedElevatedSender({
    cfg: params.cfg,
    provider: params.provider,
    ctx: params.ctx,
    allowFrom: globalConfig?.allowFrom,
    fallbackAllowFrom,
  });
  if (!globalAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `tools.elevated.allowFrom.${params.provider}`,
    });
    return { enabled, allowed: false, failures };
  }

  const agentAllowed = agentConfig?.allowFrom
    ? isApprovedElevatedSender({
        cfg: params.cfg,
        provider: params.provider,
        ctx: params.ctx,
        allowFrom: agentConfig.allowFrom,
        fallbackAllowFrom,
      })
    : true;
  if (!agentAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `agents.list[].tools.elevated.allowFrom.${params.provider}`,
    });
  }
  return { enabled, allowed: globalAllowed && agentAllowed, failures };
}
