import { resolveAccountEntry } from "../../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
function listConfigWriteTargetScopes(target) {
    if (!target || target.kind === "global") {
        return [];
    }
    if (target.kind === "ambiguous") {
        return target.scopes;
    }
    return [target.scope];
}
function resolveChannelConfig(cfg, channelId) {
    if (!channelId) {
        return undefined;
    }
    return cfg.channels?.[channelId];
}
function resolveChannelAccountConfig(channelConfig, accountId) {
    return resolveAccountEntry(channelConfig.accounts, normalizeAccountId(accountId));
}
export function resolveChannelConfigWritesShared(params) {
    const channelConfig = resolveChannelConfig(params.cfg, params.channelId);
    if (!channelConfig) {
        return true;
    }
    const accountConfig = resolveChannelAccountConfig(channelConfig, params.accountId);
    const value = accountConfig?.configWrites ?? channelConfig.configWrites;
    return value !== false;
}
export function authorizeConfigWriteShared(params) {
    if (params.allowBypass) {
        return { allowed: true };
    }
    if (params.target?.kind === "ambiguous") {
        return { allowed: false, reason: "ambiguous-target" };
    }
    if (params.origin?.channelId &&
        !resolveChannelConfigWritesShared({
            cfg: params.cfg,
            channelId: params.origin.channelId,
            accountId: params.origin.accountId,
        })) {
        return {
            allowed: false,
            reason: "origin-disabled",
            blockedScope: { kind: "origin", scope: params.origin },
        };
    }
    const seen = new Set();
    for (const target of listConfigWriteTargetScopes(params.target)) {
        if (!target.channelId) {
            continue;
        }
        const key = `${target.channelId}:${normalizeAccountId(target.accountId)}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (!resolveChannelConfigWritesShared({
            cfg: params.cfg,
            channelId: target.channelId,
            accountId: target.accountId,
        })) {
            return {
                allowed: false,
                reason: "target-disabled",
                blockedScope: { kind: "target", scope: target },
            };
        }
    }
    return { allowed: true };
}
export function resolveExplicitConfigWriteTargetShared(scope) {
    if (!scope.channelId) {
        return { kind: "global" };
    }
    const accountId = normalizeAccountId(scope.accountId);
    if (!accountId || accountId === DEFAULT_ACCOUNT_ID) {
        return { kind: "channel", scope: { channelId: scope.channelId } };
    }
    return { kind: "account", scope: { channelId: scope.channelId, accountId } };
}
export function resolveConfigWriteTargetFromPathShared(params) {
    if (params.path[0] !== "channels") {
        return { kind: "global" };
    }
    if (params.path.length < 2) {
        return { kind: "ambiguous", scopes: [] };
    }
    const channelId = params.normalizeChannelId(params.path[1] ?? "");
    if (!channelId) {
        return { kind: "ambiguous", scopes: [] };
    }
    if (params.path.length === 2) {
        return { kind: "ambiguous", scopes: [{ channelId }] };
    }
    if (params.path[2] !== "accounts") {
        return { kind: "channel", scope: { channelId } };
    }
    if (params.path.length < 4) {
        return { kind: "ambiguous", scopes: [{ channelId }] };
    }
    return resolveExplicitConfigWriteTargetShared({
        channelId,
        accountId: normalizeAccountId(params.path[3]),
    });
}
export function canBypassConfigWritePolicyShared(params) {
    return (params.isInternalMessageChannel(params.channel) &&
        params.gatewayClientScopes?.includes("operator.admin") === true);
}
export function formatConfigWriteDeniedMessageShared(params) {
    if (params.result.reason === "ambiguous-target") {
        return "⚠️ Channel-initiated /config writes cannot replace channels, channel roots, or accounts collections. Use a more specific path or gateway operator.admin.";
    }
    const blocked = params.result.blockedScope?.scope;
    const channelLabel = blocked?.channelId ?? params.fallbackChannelId ?? "this channel";
    const hint = blocked?.channelId
        ? blocked.accountId
            ? `channels.${blocked.channelId}.accounts.${blocked.accountId}.configWrites=true`
            : `channels.${blocked.channelId}.configWrites=true`
        : params.fallbackChannelId
            ? `channels.${params.fallbackChannelId}.configWrites=true`
            : "channels.<channel>.configWrites=true";
    return `⚠️ Config writes are disabled for ${channelLabel}. Set ${hint} to enable.`;
}
