import { upsertChannelPairingRequest } from "../../pairing/pairing-store.js";
export async function handleDiscordDmCommandDecision(params) {
    if (params.dmAccess.decision === "allow") {
        return true;
    }
    if (params.dmAccess.decision === "pairing") {
        const upsertPairingRequest = params.upsertPairingRequest ?? upsertChannelPairingRequest;
        const { code, created } = await upsertPairingRequest({
            channel: "discord",
            id: params.sender.id,
            accountId: params.accountId,
            meta: {
                tag: params.sender.tag,
                name: params.sender.name,
            },
        });
        if (created) {
            await params.onPairingCreated(code);
        }
        return false;
    }
    await params.onUnauthorized();
    return false;
}
