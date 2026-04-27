import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { getChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { addFormattedTokens, buildMutableTokens, matchesFormattedTokens, matchesMutableTokens, parseExplicitElevatedAllowEntry, stripSenderPrefix, } from "./elevated-allowlist-matcher.js";
export { formatElevatedUnavailableMessage } from "./elevated-unavailable.js";
function resolveElevatedAllowList(allowFrom, provider, fallbackAllowFrom) {
    if (!allowFrom) {
        return fallbackAllowFrom;
    }
    const value = allowFrom[provider];
    return Array.isArray(value) ? value : fallbackAllowFrom;
}
function resolveAllowFromFormatter(params) {
    const normalizedProvider = normalizeChannelId(params.provider);
    const formatAllowFrom = normalizedProvider
        ? getChannelPlugin(normalizedProvider)?.config?.formatAllowFrom
        : undefined;
    if (!formatAllowFrom) {
        return (values) => normalizeStringEntries(values);
    }
    return (values) => formatAllowFrom({
        cfg: params.cfg,
        accountId: params.accountId,
        allowFrom: values,
    })
        .map((entry) => normalizeOptionalString(entry) ?? "")
        .filter(Boolean);
}
function isApprovedElevatedSender(params) {
    const rawAllow = resolveElevatedAllowList(params.allowFrom, params.provider, params.fallbackAllowFrom);
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
    const senderIdTokens = new Set();
    const senderFromTokens = new Set();
    const senderE164Tokens = new Set();
    const senderId = normalizeOptionalString(params.ctx.SenderId);
    const senderFrom = normalizeOptionalString(params.ctx.From);
    const senderE164 = normalizeOptionalString(params.ctx.SenderE164);
    if (senderId) {
        addFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            values: [senderId, stripSenderPrefix(senderId)].filter((value) => Boolean(value)),
            tokens: senderIdTokens,
        });
    }
    if (senderFrom) {
        addFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            values: [senderFrom, stripSenderPrefix(senderFrom)].filter((value) => Boolean(value)),
            tokens: senderFromTokens,
        });
    }
    if (senderE164) {
        addFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            values: [senderE164],
            tokens: senderE164Tokens,
        });
    }
    const senderIdentityTokens = new Set([
        ...senderIdTokens,
        ...senderFromTokens,
        ...senderE164Tokens,
    ]);
    const senderNameTokens = buildMutableTokens(params.ctx.SenderName);
    const senderUsernameTokens = buildMutableTokens(params.ctx.SenderUsername);
    const senderTagTokens = buildMutableTokens(params.ctx.SenderTag);
    const explicitFieldMatchers = {
        id: (value) => matchesFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            value,
            includeStripped: true,
            tokens: senderIdTokens,
        }),
        from: (value) => matchesFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            value,
            includeStripped: true,
            tokens: senderFromTokens,
        }),
        e164: (value) => matchesFormattedTokens({
            formatAllowFrom: params.formatAllowFrom,
            value,
            tokens: senderE164Tokens,
        }),
        name: (value) => matchesMutableTokens(value, senderNameTokens),
        username: (value) => matchesMutableTokens(value, senderUsernameTokens),
        tag: (value) => matchesMutableTokens(value, senderTagTokens),
    };
    for (const entry of allowTokens) {
        const explicitEntry = parseExplicitElevatedAllowEntry(entry);
        if (!explicitEntry) {
            if (matchesFormattedTokens({
                formatAllowFrom: params.formatAllowFrom,
                value: entry,
                includeStripped: true,
                tokens: senderIdentityTokens,
            })) {
                return true;
            }
            continue;
        }
        const matchesExplicitField = explicitFieldMatchers[explicitEntry.field];
        if (matchesExplicitField(explicitEntry.value)) {
            return true;
        }
    }
    return false;
}
export function resolveElevatedPermissions(params) {
    const globalConfig = params.cfg.tools?.elevated;
    const agentConfig = resolveAgentConfig(params.cfg, params.agentId)?.tools?.elevated;
    const globalEnabled = globalConfig?.enabled !== false;
    const agentEnabled = agentConfig?.enabled !== false;
    const enabled = globalEnabled && agentEnabled;
    const failures = [];
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
            key: `agents.list[].tools.elevated.allowFrom.${params.provider}`,
        });
    }
    return { enabled, allowed: globalAllowed && agentAllowed, failures };
}
