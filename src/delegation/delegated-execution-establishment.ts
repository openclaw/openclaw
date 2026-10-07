/**
 * Host-owned delegated execution establishment.
 *
 * The Host establishes delegated ownership BEFORE it ever attempts the delegate
 * owner handoff, so a missing plugin, a missing handler, or a throwing delegate
 * cannot reopen ordinary execution. The required order is:
 *
 *   Host delegation intent (Host-minted, unforgeable)
 *   -> delegation_ref + canonical lineage_ref
 *   -> durable acquire DELEGATED_LOCKED
 *   -> bind the Host-owned delegation context
 *   -> ONLY THEN attempt the delegate owner
 *   -> owner available -> record it and attach delegate_goal_ref when known
 *      owner missing / handler missing / plugin unavailable / handoff failure
 *                       -> record DELEGATE_OWNER_UNAVAILABLE, KEEP the lock
 *
 * Nothing here is MUSE-specific; it is the generic Host seam.
 */
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { bindDelegatedExecutionLineage } from "./delegated-execution-lineage.js";
import {
  acquireDelegatedExecutionOwnership,
  recordDelegateOwnerAvailable,
  recordDelegateOwnerUnavailable,
} from "./delegated-execution-ownership.js";
import type { DelegatedExecutionOwnershipRecord } from "./delegated-execution-ownership.types.js";
import { readHostDelegationIntent, type HostDelegationIntent } from "./host-delegation-intent.js";

/** What the delegate owner reports back once the Host has handed the turn over. */
export type DelegateOwnerHandoff =
  | { kind: "owner-available"; delegateGoalRef?: string | null }
  | { kind: "owner-unavailable"; reason?: string }
  | { kind: "handoff-failed"; reason?: string };

export type DelegatedExecutionEstablishmentHandoff =
  | "owner-available"
  | "owner-unavailable"
  | "handoff-failed";

export type DelegatedExecutionEstablishment = Readonly<{
  delegationRef: string;
  lineageRef: string;
  ownerKind: string;
  ownerId: string;
  /** What actually happened at the handoff. */
  handoff: DelegatedExecutionEstablishmentHandoff;
  ownerState: DelegatedExecutionOwnershipRecord["ownerState"];
  delegateGoalRef: string | null;
  /** Ownership stays reserved until a terminal event or an authorized human revoke. */
  locked: true;
  /** The Host execution context that now carries the delegated lineage. */
  context: object;
  record: DelegatedExecutionOwnershipRecord;
}>;

export type EstablishDelegatedExecutionOwnershipParams = Readonly<{
  /** Host-minted delegation binding. Anything the Host did not mint is refused. */
  intent: HostDelegationIntent;
  /** Host execution context that must carry the delegated lineage. */
  context: object;
  /** Attempted only after the lock and the lineage binding are durable. */
  delegate: (handoff: {
    delegationRef: string;
    lineageRef: string;
    ownerKind: string;
    ownerId: string;
  }) => DelegateOwnerHandoff | Promise<DelegateOwnerHandoff>;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}>;

function normalizeHandoff(value: unknown): DelegateOwnerHandoff {
  if (typeof value !== "object" || value === null) {
    return { kind: "handoff-failed", reason: "delegate owner handoff returned no outcome" };
  }
  const kind = Reflect.get(value, "kind");
  if (kind === "owner-available" || kind === "owner-unavailable" || kind === "handoff-failed") {
    return value as DelegateOwnerHandoff;
  }
  return { kind: "handoff-failed", reason: "delegate owner handoff returned an unknown outcome" };
}

export async function establishDelegatedExecutionOwnership(
  params: EstablishDelegatedExecutionOwnershipParams,
): Promise<DelegatedExecutionEstablishment> {
  const intent = readHostDelegationIntent(params.intent);
  if (!intent) {
    throw new Error("delegated execution establishment requires a Host-minted delegation intent");
  }
  if (typeof params.context !== "object" || params.context === null) {
    throw new Error("delegated execution establishment requires a Host execution context");
  }
  const options = params.options ?? {};
  const optionalNow = params.now === undefined ? {} : { now: params.now };

  // 1) Durable reservation first, so there is no unguarded interval between the
  //    Host delegation decision and the delegate handoff.
  acquireDelegatedExecutionOwnership({
    delegationRef: intent.delegationRef,
    ownerKind: intent.ownerKind,
    ownerId: intent.ownerId,
    taskScopeRef: intent.taskScopeRef,
    lineageRef: intent.lineageRef,
    ...(intent.delegateGoalRef === null ? {} : { delegateGoalRef: intent.delegateGoalRef }),
    ...optionalNow,
    options,
  });

  // 2) Bind the Host-owned delegation context before the handoff is attempted.
  bindDelegatedExecutionLineage(params.context, intent.lineageRef);

  // 3) ONLY NOW attempt the delegate owner.
  let handoff: DelegateOwnerHandoff;
  try {
    handoff = normalizeHandoff(
      await params.delegate({
        delegationRef: intent.delegationRef,
        lineageRef: intent.lineageRef,
        ownerKind: intent.ownerKind,
        ownerId: intent.ownerId,
      }),
    );
  } catch (error) {
    handoff = {
      kind: "handoff-failed",
      reason: error instanceof Error ? error.message : "delegate owner handoff threw",
    };
  }

  const handoffParams = {
    delegationRef: intent.delegationRef,
    ownerKind: intent.ownerKind,
    ownerId: intent.ownerId,
    ...optionalNow,
    options,
  };
  const delegateGoalRef =
    handoff.kind === "owner-available" ? (handoff.delegateGoalRef ?? intent.delegateGoalRef) : null;

  let record: DelegatedExecutionOwnershipRecord;
  let reported: DelegatedExecutionEstablishmentHandoff;
  if (handoff.kind === "owner-available") {
    record = recordDelegateOwnerAvailable({ ...handoffParams, delegateGoalRef });
    reported = "owner-available";
  } else {
    record = recordDelegateOwnerUnavailable(handoffParams);
    reported = handoff.kind;
  }

  return Object.freeze({
    delegationRef: intent.delegationRef,
    lineageRef: intent.lineageRef,
    ownerKind: intent.ownerKind,
    ownerId: intent.ownerId,
    handoff: reported,
    ownerState: record.ownerState,
    delegateGoalRef: record.delegateGoalRef,
    locked: true as const,
    context: params.context,
    record,
  });
}
