/**
 * Frozen vocabulary for durable delegated-execution ownership.
 *
 * DIRECT work is the implicit ABSENCE of a live ownership record: there is no
 * persisted DIRECT row, so a missing/unknown registry entry can never be read
 * as an explicit grant.
 */

/** States a persisted ownership row may hold. DIRECT is never persisted. */
export const DELEGATED_EXECUTION_OWNERSHIP_STATES = [
  "DELEGATED_LOCKED",
  "FALLBACK_AUTHORIZED",
  "RELEASED",
] as const;

export type DelegatedExecutionOwnershipState =
  (typeof DELEGATED_EXECUTION_OWNERSHIP_STATES)[number];

/** States that still reserve delegated work and therefore deny ordinary execution. */
export const DELEGATED_EXECUTION_OWNERSHIP_LIVE_STATES = [
  "DELEGATED_LOCKED",
  "FALLBACK_AUTHORIZED",
] as const satisfies readonly DelegatedExecutionOwnershipState[];

/** Closed transition vocabulary. Vague reasons are deliberately not representable. */
export const DELEGATED_EXECUTION_OWNERSHIP_EVENTS = [
  "DELEGATION_ESTABLISHED",
  "DELEGATE_OWNER_UNAVAILABLE",
  "DELEGATE_OWNER_AVAILABLE",
  "HUMAN_FALLBACK_AUTHORIZED",
  "DELEGATE_TERMINAL_COMPLETED",
  "DELEGATE_TERMINAL_CANCELLED",
  "DELEGATE_TERMINAL_HANDBACK",
  "HUMAN_REVOKED_DELEGATION",
] as const;

export type DelegatedExecutionOwnershipEvent =
  (typeof DELEGATED_EXECUTION_OWNERSHIP_EVENTS)[number];

/** Events that terminate the delegation and release the reservation. */
export const DELEGATED_EXECUTION_OWNERSHIP_TERMINAL_EVENTS = [
  "DELEGATE_TERMINAL_COMPLETED",
  "DELEGATE_TERMINAL_CANCELLED",
  "DELEGATE_TERMINAL_HANDBACK",
  "HUMAN_REVOKED_DELEGATION",
] as const satisfies readonly DelegatedExecutionOwnershipEvent[];

export type DelegatedExecutionOwnershipTerminalEvent =
  (typeof DELEGATED_EXECUTION_OWNERSHIP_TERMINAL_EVENTS)[number];

/** Events no Host actor may use to release a lock. Documented, and asserted in tests. */
export const DELEGATED_EXECUTION_OWNERSHIP_NON_RELEASING_REASONS = [
  "timeout",
  "plugin-unload",
  "plugin-crash",
  "missing-handler",
  "gateway-restart",
  "model-decision",
  "muse-approval",
  "tool-failure",
  "planner-refusal",
] as const;

/** Bumped when the enforcement semantics of this feature change incompatibly. */
export const DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION = 1;

export type DelegatedExecutionOwnershipOwnerState = "available" | "unavailable";

export type DelegatedExecutionOwnershipActorKind = "host" | "delegate" | "trusted-human";

export type DelegatedExecutionOwnershipRecord = Readonly<{
  delegationRef: string;
  state: DelegatedExecutionOwnershipState;
  revision: number;
  ownerKind: string;
  ownerId: string;
  ownerState: DelegatedExecutionOwnershipOwnerState;
  delegateGoalRef: string | null;
  taskScopeRef: string;
  lineageRef: string | null;
  contextId: string | null;
  executionId: string | null;
  runId: string | null;
  enforcementFloor: number;
  authorityRef: string | null;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
  releaseEvent: DelegatedExecutionOwnershipTerminalEvent | null;
  lastEvent: DelegatedExecutionOwnershipEvent;
}>;

export type DelegatedExecutionOwnershipConflictReason =
  | "stale-revision"
  | "unexpected-state"
  | "ref-mismatch"
  | "actor-mismatch"
  | "boundary-violation";

export type DelegatedExecutionOwnershipTransitionResult =
  | { kind: "applied"; record: DelegatedExecutionOwnershipRecord }
  | { kind: "idempotent"; record: DelegatedExecutionOwnershipRecord }
  | {
      kind: "conflict";
      reason: DelegatedExecutionOwnershipConflictReason;
      record: DelegatedExecutionOwnershipRecord | undefined;
    };

/** Registry reads fail closed: an unusable registry is never reported as DIRECT. */
export type DelegatedExecutionOwnershipLookup =
  | { kind: "direct" }
  | { kind: "owned"; record: DelegatedExecutionOwnershipRecord }
  | { kind: "conflict"; reason: DelegatedExecutionOwnershipConflictReason }
  | { kind: "unavailable"; reason: string };
