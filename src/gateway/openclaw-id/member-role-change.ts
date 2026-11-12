import type {
  AuthorityEvent,
  AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";

// A member whose role changed reconnects, so their Gateway connections pick up the
// new role's scope ceiling instead of keeping the one granted at connect.
export function roleChangeDisconnects(
  before: AuthorityState,
  after: AuthorityState,
): AuthorityEvent[] {
  const peerKeys = Object.entries(after.members).flatMap(([accountId, member]) => {
    const previous = before.members[accountId];
    return previous && previous.role !== member.role ? member.peer_keys : [];
  });
  return peerKeys.length > 0 ? [{ type: "disconnect", peer_keys: peerKeys }] : [];
}
