import {
  parseStatement,
  type AuthorityEvent,
  type AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { AuthorityRefusal } from "./authority-result.js";

class UndefinedMemberRoleError extends Error {
  constructor(role: string) {
    super(`The role ${role} is not defined on this claw. Choose another role on the Access page.`);
  }
}

export function refuseUndefinedMemberRole(error: unknown): AuthorityRefusal {
  if (error instanceof UndefinedMemberRoleError) {
    return { ok: false, code: "role_undefined", detail: error.message };
  }
  throw error;
}

/** Validate the target role once when the queued owner-signed change starts. */
export function assertMemberRoleDefined(input: unknown): void {
  const change = parseStatement(input, "MembershipChange");
  const role =
    change.ok && change.statement.body.target.op === "set_role"
      ? change.statement.body.target.role
      : undefined;
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
