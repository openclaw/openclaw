import {
  parseStatement,
  type AuthorityEvent,
  type AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { getRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { onOperatorRolePolicyChanged } from "../operator-role-policy.js";
import type { AuthorityRefusal } from "./authority-result.js";

/** A role grant the authority refuses after the owner's statement verified. */
class MemberRoleRefusal extends Error {
  constructor(
    readonly code: "role_undefined" | "sandbox_unavailable",
    detail: string,
  ) {
    super(detail);
  }
}

export function refuseMemberRole(error: unknown): AuthorityRefusal {
  if (error instanceof MemberRoleRefusal) {
    return { ok: false, code: error.code, detail: error.message };
  }
  throw error;
}

/** The role a MembershipChange moves an existing member to, if it is a role change. */
function changedMemberRole(input: unknown): string | undefined {
  const change = parseStatement(input, "MembershipChange");
  return change.ok && change.statement.body.target.op === "set_role"
    ? change.statement.body.target.role
    : undefined;
}

/** Validate the target role once when the queued owner-signed change starts. */
export function assertMemberRoleDefined(input: unknown) {
  const change = parseStatement(input, "MembershipChange");
  const target =
    change.ok && change.statement.body.target.op === "set_role"
      ? change.statement.body.target
      : undefined;
  const role = target?.role;
  if (
    role !== undefined &&
    !Object.hasOwn(getRuntimeConfigSnapshot()?.gateway?.roles?.definitions ?? {}, role)
  ) {
    throw new MemberRoleRefusal(
      "role_undefined",
      `The role ${role} is not defined on this claw. Choose another role on the Access page.`,
    );
  }
  return target;
}

/** The role an InviteCap grants when redeemed. */
function invitedMemberRole(cap: unknown): string | undefined {
  const parsed = parseStatement(cap, "InviteCap");
  return parsed.ok ? parsed.statement.body.role : undefined;
}

/**
 * Refuses granting a role that requires a sandbox while that sandbox cannot start, so the
 * owner sets up sandboxing before inviting or moving anyone to the role. Runs on the write
 * queue after the statement verified, so grants keep their order and forged statements
 * never reach the engine; the probes are time-bounded.
 */
export async function assertSandboxGrantReady(grant: unknown): Promise<void> {
  const role = changedMemberRole(grant) ?? invitedMemberRole(grant);
  const cfg = getRuntimeConfigSnapshot() ?? undefined;
  const definitions = cfg?.gateway?.roles?.definitions ?? {};
  const definition =
    role !== undefined && Object.hasOwn(definitions, role) ? definitions[role] : undefined;
  if (role === undefined || definition?.sandbox !== "required") {
    return;
  }
  const { createRoleSandboxReadinessCheck, sandboxUnavailableDetail } =
    await import("./sandbox-availability.js");
  const readiness = await createRoleSandboxReadinessCheck(cfg)(definition.agents);
  if (readiness.ready === false) {
    throw new MemberRoleRefusal("sandbox_unavailable", sandboxUnavailableDetail(role, readiness));
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

/** Refresh the display label and Discovery mirror when the profile authority changes. */
export function publishMemberProfileRoleChanges(params: {
  enabled: () => boolean;
  changed: () => void;
  publish: () => Promise<void>;
  warn: (message: string) => void;
}): () => void {
  return onOperatorRolePolicyChanged(() => {
    if (!params.enabled()) {
      return;
    }
    params.changed();
    void params
      .publish()
      .catch((error: unknown) =>
        params.warn(`openclaw-id: role label publication failed: ${String(error)}`),
      );
  });
}
