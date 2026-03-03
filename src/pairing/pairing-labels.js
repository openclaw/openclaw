import { getPairingAdapter } from "../channels/plugins/pairing.js";
export function resolvePairingIdLabel(channel) {
    return getPairingAdapter(channel)?.idLabel ?? "userId";
}
