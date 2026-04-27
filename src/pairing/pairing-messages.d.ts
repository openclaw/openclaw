import type { PairingChannel } from "./pairing-store.types.js";
export declare function buildPairingReply(params: {
    channel: PairingChannel;
    idLine: string;
    code: string;
}): string;
