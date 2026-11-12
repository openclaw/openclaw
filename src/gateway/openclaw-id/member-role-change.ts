import type {
  AuthorityEvent,
  AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { PluginStateStoreError } from "../../plugin-state/plugin-state-error.js";
import type { AuthorityRefusal } from "./authority-result.js";

export class UndefinedMemberRoleError extends Error {
  constructor(role: string) {
    super(`The role ${role} is not defined on this claw. Choose another role on the Access page.`);
  }
}

/** Storage admission wraps the original local refusal as its typed cause. */
export function refuseUndefinedMemberRole(error: unknown): AuthorityRefusal {
  const cause = error instanceof PluginStateStoreError ? error.cause : error;
  if (cause instanceof UndefinedMemberRoleError) {
    return { ok: false, code: "role_undefined", detail: cause.message };
  }
  throw error;
}

/** Passed to the store's live pre-commit assertion for owner-signed set_role. */
export function assertMemberRoleDefined(role: string | undefined): void {
  if (
    role !== undefined &&
    !Object.hasOwn(getRuntimeConfigSnapshot()?.gateway?.roles?.definitions ?? {}, role)
  ) {
    throw new UndefinedMemberRoleError(role);
  }
}

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
