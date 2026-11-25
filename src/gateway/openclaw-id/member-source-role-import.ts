import { isDeepStrictEqual } from "node:util";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";
import { resolveMissingOperatorScope } from "../../shared/operator-scope-compat.js";
import { sourceRolePolicy } from "../operator-role-source-policy.js";
import type {
  OperatorRunRecoverySnapshot,
  QueuedOperatorRecoverySource,
} from "../operator-run-recovery-source.codec.js";

export type LegacyOpenClawIdMemberRoleImport = {
  profileId: string;
  accountId: string;
  role: string;
  policy: GatewayOperatorRoleDefinition;
};

/** Import representation only: the captured membership policy must already grant every scope. */
export function importLegacyMemberSnapshot(
  snapshot: OperatorRunRecoverySnapshot,
  input: LegacyOpenClawIdMemberRoleImport,
): OperatorRunRecoverySnapshot {
  const principal = snapshot.openclawIdPrincipal;
  if (
    snapshot.profileId !== input.profileId ||
    snapshot.assignedRole !== null ||
    principal?.kind !== "member" ||
    principal.accountId !== input.accountId ||
    principal.role !== input.role ||
    !isDeepStrictEqual(snapshot.rolePolicy, sourceRolePolicy(input.policy)) ||
    resolveMissingOperatorScope(snapshot.scopes, input.policy.scopes) !== null
  ) {
    return snapshot;
  }
  return { ...snapshot, assignedRole: input.role };
}

export function importLegacyMemberQueuedSource(
  source: QueuedOperatorRecoverySource,
  input: LegacyOpenClawIdMemberRoleImport,
): QueuedOperatorRecoverySource {
  if (source.kind !== "gateway") {
    return source;
  }
  const snapshot = importLegacyMemberSnapshot(source.snapshot, input);
  return snapshot === source.snapshot ? source : { ...source, snapshot };
}
