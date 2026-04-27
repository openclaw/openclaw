import { hasConfiguredUnavailableCredentialStatus, hasResolvedCredentialValue, } from "./account-snapshot-fields.js";
import { resolveChannelAccountConfigured, resolveChannelAccountEnabled, } from "./account-summary.js";
import { inspectReadOnlyChannelAccount } from "./read-only-account-inspect.js";
export async function inspectChannelAccount(params) {
    return (params.plugin.config.inspectAccount?.(params.cfg, params.accountId) ??
        (await inspectReadOnlyChannelAccount({
            channelId: params.plugin.id,
            cfg: params.cfg,
            accountId: params.accountId,
        })));
}
export async function resolveInspectedChannelAccount(params) {
    const sourceInspectedAccount = await inspectChannelAccount({
        plugin: params.plugin,
        cfg: params.sourceConfig,
        accountId: params.accountId,
    });
    const resolvedInspectedAccount = await inspectChannelAccount({
        plugin: params.plugin,
        cfg: params.cfg,
        accountId: params.accountId,
    });
    const resolvedInspection = resolvedInspectedAccount;
    const sourceInspection = sourceInspectedAccount;
    const resolvedAccount = resolvedInspectedAccount ?? params.plugin.config.resolveAccount(params.cfg, params.accountId);
    const useSourceUnavailableAccount = Boolean(sourceInspectedAccount &&
        hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
        (!hasResolvedCredentialValue(resolvedAccount) ||
            (sourceInspection?.configured === true && resolvedInspection?.configured === false)));
    const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
    const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
    const enabled = selectedInspection?.enabled ??
        resolveChannelAccountEnabled({ plugin: params.plugin, account, cfg: params.cfg });
    const configured = selectedInspection?.configured ??
        (await resolveChannelAccountConfigured({
            plugin: params.plugin,
            account,
            cfg: params.cfg,
            readAccountConfiguredField: true,
        }));
    return { account, enabled, configured };
}
