import { collectEmptyAllowlistPolicyWarningsForAccount } from "./empty-allowlist-policy.js";
import { asObjectRecord } from "./object.js";
function isDisabledRecord(value) {
    return (Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
        value.enabled === false);
}
export function scanEmptyAllowlistPolicyWarnings(cfg, params) {
    const channels = cfg.channels;
    if (!channels || typeof channels !== "object") {
        return [];
    }
    const warnings = [];
    const checkAccount = (account, prefix, channelName, parent) => {
        const accountDm = asObjectRecord(account.dm);
        const parentDm = asObjectRecord(parent?.dm);
        const dmPolicy = account.dmPolicy ??
            accountDm?.policy ??
            parent?.dmPolicy ??
            parentDm?.policy ??
            undefined;
        const effectiveAllowFrom = account.allowFrom ??
            parent?.allowFrom ??
            accountDm?.allowFrom ??
            parentDm?.allowFrom ??
            undefined;
        warnings.push(...collectEmptyAllowlistPolicyWarningsForAccount({
            account,
            channelName,
            cfg,
            doctorFixCommand: params.doctorFixCommand,
            parent,
            prefix,
            shouldSkipDefaultEmptyGroupAllowlistWarning: params.shouldSkipDefaultEmptyGroupAllowlistWarning,
        }));
        if (params.extraWarningsForAccount) {
            warnings.push(...params.extraWarningsForAccount({
                account,
                channelName,
                dmPolicy,
                effectiveAllowFrom,
                parent,
                prefix,
            }));
        }
    };
    for (const [channelName, channelConfig] of Object.entries(channels)) {
        if (!channelConfig || typeof channelConfig !== "object") {
            continue;
        }
        if (isDisabledRecord(channelConfig)) {
            continue;
        }
        checkAccount(channelConfig, `channels.${channelName}`, channelName);
        const accounts = asObjectRecord(channelConfig.accounts);
        if (!accounts) {
            continue;
        }
        for (const [accountId, account] of Object.entries(accounts)) {
            if (!account || typeof account !== "object") {
                continue;
            }
            if (isDisabledRecord(account)) {
                continue;
            }
            checkAccount(account, `channels.${channelName}.accounts.${accountId}`, channelName, channelConfig);
        }
    }
    return warnings;
}
