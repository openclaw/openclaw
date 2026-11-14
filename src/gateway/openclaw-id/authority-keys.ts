// Which tunnel keys a claw's membership lists, read by the authority and owner reset.
import {
  isAdmitted,
  isIrohEndpointKey,
  type AuthorityState,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";

// Every listed node, member or owner device key, admitted now or not.
export function memberKeys(state: AuthorityState): Set<IrohEndpointKey> {
  return new Set<IrohEndpointKey>([
    ...Object.values(state.members).flatMap((member) => member.peer_keys),
    ...Object.values(state.owner_devices).flatMap((record) => record.cert.body.peer_keys),
    ...Object.keys(state.nodes).filter(isIrohEndpointKey),
  ]);
}

// Every candidate key that passes the protocol's admission rule at `now`.
export function listAdmitted(state: AuthorityState, now: number): IrohEndpointKey[] {
  return [...memberKeys(state)].filter((key) => isAdmitted(state, key, now)).toSorted();
}
