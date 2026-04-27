import { defineLegacyConfigMigration, getRecord, } from "../../../config/legacy.shared.js";
function hasOwnKey(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
}
function hasLegacyThreadBindingTtl(value) {
    const threadBindings = getRecord(value);
    return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
}
function hasLegacyThreadBindingTtlInAccounts(value) {
    const accounts = getRecord(value);
    if (!accounts) {
        return false;
    }
    return Object.values(accounts).some((entry) => hasLegacyThreadBindingTtl(getRecord(entry)?.threadBindings));
}
function migrateThreadBindingsTtlHoursForPath(params) {
    const threadBindings = getRecord(params.owner.threadBindings);
    if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
        return false;
    }
    const hadIdleHours = threadBindings.idleHours !== undefined;
    if (!hadIdleHours) {
        threadBindings.idleHours = threadBindings.ttlHours;
    }
    delete threadBindings.ttlHours;
    params.owner.threadBindings = threadBindings;
    if (hadIdleHours) {
        params.changes.push(`Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`);
    }
    else {
        params.changes.push(`Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`);
    }
    return true;
}
function hasLegacyThreadBindingTtlInAnyChannel(value) {
    const channels = getRecord(value);
    if (!channels) {
        return false;
    }
    return Object.values(channels).some((entry) => {
        const channel = getRecord(entry);
        if (!channel) {
            return false;
        }
        return (hasLegacyThreadBindingTtl(channel.threadBindings) ||
            hasLegacyThreadBindingTtlInAccounts(channel.accounts));
    });
}
const THREAD_BINDING_RULES = [
    {
        path: ["session", "threadBindings"],
        message: 'session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours. Run "openclaw doctor --fix".',
        match: (value) => hasLegacyThreadBindingTtl(value),
    },
    {
        path: ["channels"],
        message: 'channels.<id>.threadBindings.ttlHours was renamed to channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
        match: (value) => hasLegacyThreadBindingTtlInAnyChannel(value),
    },
];
export const LEGACY_CONFIG_MIGRATIONS_CHANNELS = [
    defineLegacyConfigMigration({
        id: "thread-bindings.ttlHours->idleHours",
        describe: "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channel configs)",
        legacyRules: THREAD_BINDING_RULES,
        apply: (raw, changes) => {
            const session = getRecord(raw.session);
            if (session) {
                migrateThreadBindingsTtlHoursForPath({
                    owner: session,
                    pathPrefix: "session",
                    changes,
                });
                raw.session = session;
            }
            const channels = getRecord(raw.channels);
            if (!channels) {
                return;
            }
            for (const [channelId, channelRaw] of Object.entries(channels)) {
                const channel = getRecord(channelRaw);
                if (!channel) {
                    continue;
                }
                migrateThreadBindingsTtlHoursForPath({
                    owner: channel,
                    pathPrefix: `channels.${channelId}`,
                    changes,
                });
                const accounts = getRecord(channel.accounts);
                if (accounts) {
                    for (const [accountId, accountRaw] of Object.entries(accounts)) {
                        const account = getRecord(accountRaw);
                        if (!account) {
                            continue;
                        }
                        migrateThreadBindingsTtlHoursForPath({
                            owner: account,
                            pathPrefix: `channels.${channelId}.accounts.${accountId}`,
                            changes,
                        });
                        accounts[accountId] = account;
                    }
                    channel.accounts = accounts;
                }
                channels[channelId] = channel;
            }
            raw.channels = channels;
        },
    }),
];
