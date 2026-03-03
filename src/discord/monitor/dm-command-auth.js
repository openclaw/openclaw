import { resolveCommandAuthorizedFromAuthorizers } from "../../channels/command-gating.js";
import { readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithLists, } from "../../security/dm-policy-shared.js";
import { normalizeDiscordAllowList, resolveDiscordAllowListMatch } from "./allow-list.js";
const DISCORD_ALLOW_LIST_PREFIXES = ["discord:", "user:", "pk:"];
function resolveSenderAllowMatch(params) {
    const allowList = normalizeDiscordAllowList(params.allowEntries, DISCORD_ALLOW_LIST_PREFIXES);
    return allowList
        ? resolveDiscordAllowListMatch({
            allowList,
            candidate: params.sender,
            allowNameMatching: params.allowNameMatching,
        })
        : { allowed: false };
}
function resolveDmPolicyCommandAuthorization(params) {
    if (params.dmPolicy === "open" && params.decision === "allow") {
        return true;
    }
    return params.commandAuthorized;
}
export async function resolveDiscordDmCommandAccess(params) {
    const storeAllowFrom = params.readStoreAllowFrom
        ? await params.readStoreAllowFrom().catch(() => [])
        : await readStoreAllowFromForDmPolicy({
            provider: "discord",
            accountId: params.accountId,
            dmPolicy: params.dmPolicy,
        });
    const access = resolveDmGroupAccessWithLists({
        isGroup: false,
        dmPolicy: params.dmPolicy,
        allowFrom: params.configuredAllowFrom,
        groupAllowFrom: [],
        storeAllowFrom,
        isSenderAllowed: (allowEntries) => resolveSenderAllowMatch({
            allowEntries,
            sender: params.sender,
            allowNameMatching: params.allowNameMatching,
        }).allowed,
    });
    const allowMatch = resolveSenderAllowMatch({
        allowEntries: access.effectiveAllowFrom,
        sender: params.sender,
        allowNameMatching: params.allowNameMatching,
    });
    const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups: params.useAccessGroups,
        authorizers: [
            {
                configured: access.effectiveAllowFrom.length > 0,
                allowed: allowMatch.allowed,
            },
        ],
        modeWhenAccessGroupsOff: "configured",
    });
    return {
        decision: access.decision,
        reason: access.reason,
        commandAuthorized: resolveDmPolicyCommandAuthorization({
            dmPolicy: params.dmPolicy,
            decision: access.decision,
            commandAuthorized,
        }),
        allowMatch,
    };
}
