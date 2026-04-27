import { normalizeChatChannelId } from "../../../channels/ids.js";
import { readChannelAllowFromStore } from "../../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../../shared/string-normalization.js";
import { resolveAllowFromMode } from "./allow-from-mode.js";
import { hasAllowFromEntries } from "./allowlist.js";
import { asObjectRecord } from "./object.js";
export async function maybeRepairAllowlistPolicyAllowFrom(cfg) {
    const channels = cfg.channels;
    if (!channels || typeof channels !== "object") {
        return { config: cfg, changes: [] };
    }
    const next = structuredClone(cfg);
    const changes = [];
    const applyRecoveredAllowFrom = (params) => {
        const count = params.allowFrom.length;
        const noun = count === 1 ? "entry" : "entries";
        if (params.mode === "nestedOnly") {
            const dmEntry = params.account.dm;
            const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
                ? dmEntry
                : {};
            dm.allowFrom = params.allowFrom;
            params.account.dm = dm;
            changes.push(`- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
            return;
        }
        if (params.mode === "topOrNested") {
            const dmEntry = params.account.dm;
            const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
                ? dmEntry
                : undefined;
            const nestedAllowFrom = dm?.allowFrom;
            if (dm && !Array.isArray(params.account.allowFrom) && Array.isArray(nestedAllowFrom)) {
                dm.allowFrom = params.allowFrom;
                changes.push(`- ${params.prefix}.dm.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
                return;
            }
        }
        params.account.allowFrom = params.allowFrom;
        changes.push(`- ${params.prefix}.allowFrom: restored ${count} sender ${noun} from pairing store (dmPolicy="allowlist").`);
    };
    const recoverAllowFromForAccount = async (params) => {
        const dmEntry = params.account.dm;
        const dm = dmEntry && typeof dmEntry === "object" && !Array.isArray(dmEntry)
            ? dmEntry
            : undefined;
        const dmPolicy = params.account.dmPolicy ?? dm?.policy;
        if (dmPolicy !== "allowlist") {
            return;
        }
        const topAllowFrom = params.account.allowFrom;
        const nestedAllowFrom = dm?.allowFrom;
        if (hasAllowFromEntries(topAllowFrom) || hasAllowFromEntries(nestedAllowFrom)) {
            return;
        }
        const normalizedChannelId = normalizeOptionalLowercaseString(normalizeChatChannelId(params.channelName) ?? params.channelName);
        if (!normalizedChannelId) {
            return;
        }
        const normalizedAccountId = normalizeAccountId(params.accountId) || DEFAULT_ACCOUNT_ID;
        const fromStore = await readChannelAllowFromStore(normalizedChannelId, process.env, normalizedAccountId).catch(() => []);
        const recovered = Array.from(new Set(normalizeStringEntries(fromStore)));
        if (recovered.length === 0) {
            return;
        }
        applyRecoveredAllowFrom({
            account: params.account,
            allowFrom: recovered,
            mode: resolveAllowFromMode(params.channelName),
            prefix: params.prefix,
        });
    };
    const nextChannels = next.channels;
    for (const [channelName, channelConfig] of Object.entries(nextChannels)) {
        if (!channelConfig || typeof channelConfig !== "object") {
            continue;
        }
        if (channelConfig.enabled === false) {
            continue;
        }
        await recoverAllowFromForAccount({
            channelName,
            account: channelConfig,
            prefix: `channels.${channelName}`,
        });
        const accounts = asObjectRecord(channelConfig.accounts);
        if (!accounts) {
            continue;
        }
        for (const [accountId, accountConfig] of Object.entries(accounts)) {
            if (!accountConfig || typeof accountConfig !== "object") {
                continue;
            }
            if (accountConfig.enabled === false) {
                continue;
            }
            await recoverAllowFromForAccount({
                channelName,
                account: accountConfig,
                accountId,
                prefix: `channels.${channelName}.accounts.${accountId}`,
            });
        }
    }
    if (changes.length === 0) {
        return { config: cfg, changes: [] };
    }
    return { config: next, changes };
}
