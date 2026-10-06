import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import type { AgentElevatedAllowFromConfig, OpenClawConfig } from "../../config/config.js";
import { shouldUseFromAsSenderFallback } from "../sender-identity.js";
import type { MsgContext } from "../templating.js";
import {
  type AllowFromFormatter,
  type ExplicitElevatedAllowField,
  buildFormattedTokens,
  buildMutableTokens,
  matchesFormattedTokens,
  matchesMutableTokens,
  parseExplicitElevatedAllowEntry,
} from "./elevated-allowlist-matcher.js";
export { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";

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

function resolveAllowFromFormatter(params: {
  cfg: OpenClawConfig;
  provider: string;
  accountId?: string;
}): AllowFromFormatter {
  const normalizedProvider = normalizeChannelId(params.provider);
  const formatAllowFrom = normalizedProvider
    ? getChannelPlugin(normalizedProvider)?.config?.formatAllowFrom
    : undefined;
  if (!formatAllowFrom) {
    return (values) => normalizeStringEntries(values);
  }
  return (values) =>
    formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: values,
    })
      .map((entry) => normalizeOptionalString(entry) ?? "")
      .filter(Boolean);
}

function isApprovedElevatedSender(params: {
  provider: string;
  ctx: MsgContext;
  formatAllowFrom: AllowFromFormatter;
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

  const allowTokens = normalizeStringEntries(rawAllow);
  if (allowTokens.length === 0) {
    return false;
  }
  if (allowTokens.some((entry) => entry === "*")) {
    return true;
  }

  const senderId = normalizeOptionalString(params.ctx.SenderId);
  const senderFrom = normalizeOptionalString(params.ctx.From);
  const senderE164 = normalizeOptionalString(params.ctx.SenderE164);
  const identityTokens = (value: string | undefined, includeStripped: boolean) =>
    value
      ? buildFormattedTokens({ formatAllowFrom: params.formatAllowFrom, value, includeStripped })
      : new Set<string>();
  // Identity fields use channel formatting; mutable labels use normalized text matching.
  const fieldTokens: Record<ExplicitElevatedAllowField, Set<string>> = {
    id: identityTokens(senderId, true),
    from: identityTokens(
      senderFrom &&
        shouldUseFromAsSenderFallback({ from: senderFrom, chatType: params.ctx.ChatType })
        ? senderFrom
        : undefined,
      true,
    ),
    e164: identityTokens(senderE164, false),
    name: buildMutableTokens(params.ctx.SenderName),
    username: buildMutableTokens(params.ctx.SenderUsername),
    tag: buildMutableTokens(params.ctx.SenderTag),
  };
  const senderIdentityTokens = new Set([
    ...fieldTokens.id,
    ...fieldTokens.from,
    ...fieldTokens.e164,
  ]);

  for (const entry of allowTokens) {
    const explicitEntry = parseExplicitElevatedAllowEntry(entry);
    if (!explicitEntry) {
      if (
        matchesFormattedTokens({
          formatAllowFrom: params.formatAllowFrom,
          value: entry,
          includeStripped: true,
          tokens: senderIdentityTokens,
        })
      ) {
        return true;
      }
      continue;
    }
    const { field, value } = explicitEntry;
    const tokens = fieldTokens[field];
    const matches =
      field === "name" || field === "username" || field === "tag"
        ? matchesMutableTokens(value, tokens)
        : matchesFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            value,
            includeStripped: field !== "e164",
            tokens,
          });
    if (matches) {
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
      key: "agents.entries.*.tools.elevated.enabled",
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
  const fallbackAllowFrom = normalizedProvider
    ? getChannelPlugin(normalizedProvider)?.elevated?.allowFromFallback?.({
        cfg: params.cfg,
        accountId: params.ctx.AccountId,
      })
    : undefined;
  const formatAllowFrom = resolveAllowFromFormatter({
    cfg: params.cfg,
    provider: params.provider,
    accountId: params.ctx.AccountId,
  });
  const globalAllowed = isApprovedElevatedSender({
    provider: params.provider,
    ctx: params.ctx,
    formatAllowFrom,
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
        provider: params.provider,
        ctx: params.ctx,
        formatAllowFrom,
        allowFrom: agentConfig.allowFrom,
        fallbackAllowFrom,
      })
    : true;
  if (!agentAllowed) {
    failures.push({
      gate: "allowFrom",
      key: `agents.entries.*.tools.elevated.allowFrom.${params.provider}`,
    });
  }
  return { enabled, allowed: agentAllowed, failures };
}
