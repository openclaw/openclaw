import { issuePairingChallenge } from "../../pairing/pairing-challenge.js";
import { upsertChannelPairingRequest } from "../../pairing/pairing-store.js";
import { readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithLists, } from "../../security/dm-policy-shared.js";
import { isSignalSenderAllowed } from "../identity.js";
export async function resolveSignalAccessState(params) {
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
        provider: "signal",
        accountId: params.accountId,
        dmPolicy: params.dmPolicy,
    });
    const resolveAccessDecision = (isGroup) => resolveDmGroupAccessWithLists({
        isGroup,
        dmPolicy: params.dmPolicy,
        groupPolicy: params.groupPolicy,
        allowFrom: params.allowFrom,
        groupAllowFrom: params.groupAllowFrom,
        storeAllowFrom,
        isSenderAllowed: (allowEntries) => isSignalSenderAllowed(params.sender, allowEntries),
    });
    const dmAccess = resolveAccessDecision(false);
    return {
        resolveAccessDecision,
        dmAccess,
        effectiveDmAllow: dmAccess.effectiveAllowFrom,
        effectiveGroupAllow: dmAccess.effectiveGroupAllowFrom,
    };
}
export async function handleSignalDirectMessageAccess(params) {
    if (params.dmAccessDecision === "allow") {
        return true;
    }
    if (params.dmAccessDecision === "block") {
        if (params.dmPolicy !== "disabled") {
            params.log(`Blocked signal sender ${params.senderDisplay} (dmPolicy=${params.dmPolicy})`);
        }
        return false;
    }
    if (params.dmPolicy === "pairing") {
        await issuePairingChallenge({
            channel: "signal",
            senderId: params.senderId,
            senderIdLine: params.senderIdLine,
            meta: { name: params.senderName },
            upsertPairingRequest: async ({ id, meta }) => await upsertChannelPairingRequest({
                channel: "signal",
                id,
                accountId: params.accountId,
                meta,
            }),
            sendPairingReply: params.sendPairingReply,
            onCreated: () => {
                params.log(`signal pairing request sender=${params.senderId}`);
            },
            onReplyError: (err) => {
                params.log(`signal pairing reply failed for ${params.senderId}: ${String(err)}`);
            },
        });
    }
    return false;
}
