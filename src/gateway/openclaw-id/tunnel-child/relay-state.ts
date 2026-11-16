// Relay attachment as the tunnel child reports it. iroh clears the last error
// while it retries, so a relay-side denial is kept until the relay admits the
// endpoint (or denies it for another reason); otherwise the status would
// flicker between "denied" and "connecting" on every retry.
import type { IrohHomeRelayStatus } from "./addon.js";

/** What the child reports about its relay. */
export type RelayState = { online: boolean; denied: string | null };

/** Folds one home relay status update into the reported state. */
export function nextRelayState(previous: RelayState, relays: IrohHomeRelayStatus[]): RelayState {
  const online = relays.some((relay) => relay.connected);
  const reason = relays.find((relay) => relay.authDeniedReason)?.authDeniedReason ?? null;
  return { online, denied: online ? null : (reason ?? previous.denied) };
}
