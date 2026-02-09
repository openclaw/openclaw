import type { PairingChannel } from "./pairing-store.js";
import { getPairingAdapter } from "../channels/plugins/pairing.js";

export function resolvePairingIdLabel(channel: PairingChannel): string {
  return getPairingAdapter(channel)?.idLabel ?? "userId";
}
