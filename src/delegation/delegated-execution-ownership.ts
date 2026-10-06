/**
 * Closed event/state machine for delegated execution ownership.
 *
 * The single invariant is that ordinary OpenClaw execution is denied whenever
 * delegated work is still owned. Nothing but a closed terminal event or a
 * Host-authorized human revoke releases the reservation.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  appendOwnershipEvent,
  casOwnershipRow,
  insertOwnershipRow,
  listLiveOwnershipRows,
  readOwnershipRow,
  type OwnershipCasOutcome,
} from "./delegated-execution-ownership-store.js";
import { ensureDelegatedExecutionOwnershipSchema } from "./delegated-execution-ownership.schema.js";
import {
  DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION,
  type DelegatedExecutionOwnershipActorKind,
  type DelegatedExecutionOwnershipEvent,
  type DelegatedExecutionOwnershipLookup,
  type DelegatedExecutionOwnershipRecord,
  type DelegatedExecutionOwnershipTerminalEvent,
} from "./delegated-execution-ownership.types.js";
import {
  requireTrustedHumanFallbackAuthority,
  type TrustedHumanFallbackAuthority,
} from "./trusted-human-fallback-authority.js";

export class DelegatedExecutionOwnershipRegistryUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "DelegatedExecutionOwnershipRegistryUnavailableError";
    this.reason = reason;
  }
}

export class DelegatedExecutionOwnershipRefusedError extends Error {
  readonly code:
    | "cas-conflict"
    | "duplicate-delegation-ref"
    | "unknown-delegation-ref"
    | "invalid-transition";
  constructor(code: DelegatedExecutionOwnershipRefusedError["code"], message: string) {
    super(message);
    this.name = "DelegatedExecutionOwnershipRefusedError";
    this.code = code;
  }
}

/** Opens the registry, failing closed on open or install failure. */
export function openDelegatedExecutionOwnershipRegistry(
  options: OpenClawStateDatabaseOptions = {},
): { db: DatabaseSync; path: string } {
  let opened;
  try {
    opened = openOpenClawStateDatabase(options);
  } catch (error) {
    throw new DelegatedExecutionOwnershipRegistryUnavailableError(
      "open-failed",
      error instanceof Error ? error.message : "delegated execution ownership registry open failed",
    );
  }
  try {
    if (!ensureDelegatedExecutionOwnershipSchema(opened.db)) {
      throw new DelegatedExecutionOwnershipRegistryUnavailableError(
        "install-failed",
        "delegated execution ownership registry install did not complete",
      );
    }
  } catch (error) {
    if (error instanceof DelegatedExecutionOwnershipRegistryUnavailableError) {
      throw error;
    }
    throw new DelegatedExecutionOwnershipRegistryUnavailableError(
      "install-failed",
      error instanceof Error
        ? error.message
        : "delegated execution ownership registry install failed",
    );
  }
  return { db: opened.db, path: opened.path };
}

function eventId(params: {
  delegationRef: string;
  event: DelegatedExecutionOwnershipEvent;
  revision: number;
  occurredAt: number;
}): string {
  return [
    params.delegationRef,
    params.event,
    String(params.revision),
    String(params.occurredAt),
  ].join("#");
}

function applyOutcome(
  outcome: OwnershipCasOutcome,
  context: { delegationRef: string; event: DelegatedExecutionOwnershipEvent },
): DelegatedExecutionOwnershipRecord {
  if (outcome.kind === "applied" || outcome.kind === "idempotent") {
    return outcome.record;
  }
  if (outcome.reason === "ref-mismatch" && outcome.record === undefined) {
    throw new DelegatedExecutionOwnershipRefusedError(
      "unknown-delegation-ref",
      "no ownership record exists for delegation_ref " + context.delegationRef,
    );
  }
  throw new DelegatedExecutionOwnershipRefusedError(
    "cas-conflict",
    "delegated execution ownership transition was refused: " + outcome.reason,
  );
}

function appendTransitionEvent(
  db: DatabaseSync,
  params: {
    record: DelegatedExecutionOwnershipRecord;
    fromState: DelegatedExecutionOwnershipRecord["state"] | null;
    event: DelegatedExecutionOwnershipEvent;
    actorKind: DelegatedExecutionOwnershipActorKind;
    actorRef: string;
    authorityRef: string | null;
    detail?: unknown;
  },
): void {
  appendOwnershipEvent(db, {
    eventId: eventId({
      delegationRef: params.record.delegationRef,
      event: params.event,
      revision: params.record.revision,
      occurredAt: params.record.updatedAt,
    }),
    delegationRef: params.record.delegationRef,
    event: params.event,
    fromState: params.fromState,
    toState: params.record.state,
    revision: params.record.revision,
    actorKind: params.actorKind,
    actorRef: params.actorRef,
    authorityRef: params.authorityRef,
    occurredAt: params.record.updatedAt,
    detail: params.detail ?? {},
  });
}

export type AcquireDelegationParams = Readonly<{
  delegationRef: string;
  ownerKind: string;
  ownerId: string;
  taskScopeRef: string;
  delegateGoalRef?: string | null;
  lineageRef?: string | null;
  contextId?: string | null;
  executionId?: string | null;
  runId?: string | null;
  hostActorRef?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}>;

/**
 * Commits DELEGATED_LOCKED before any delegate handoff is attempted, so there
 * is no unguarded interval between the decision and the reservation.
 */
export function acquireDelegatedExecutionOwnership(params: AcquireDelegationParams): {
  kind: "acquired" | "duplicate";
  record: DelegatedExecutionOwnershipRecord;
} {
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureDelegatedExecutionOwnershipSchema(db);
      const inserted = insertOwnershipRow(db, {
        delegationRef: params.delegationRef,
        ownerKind: params.ownerKind,
        ownerId: params.ownerId,
        ownerState: "unavailable",
        delegateGoalRef: params.delegateGoalRef ?? null,
        taskScopeRef: params.taskScopeRef,
        lineageRef: params.lineageRef ?? null,
        contextId: params.contextId ?? null,
        executionId: params.executionId ?? null,
        runId: params.runId ?? null,
        enforcementFloor: DELEGATED_EXECUTION_OWNERSHIP_ENFORCEMENT_VERSION,
        now,
      });
      const record = readOwnershipRow(db, params.delegationRef);
      if (!record) {
        throw new DelegatedExecutionOwnershipRegistryUnavailableError(
          "read-after-write",
          "delegated execution ownership row is not readable after acquisition",
        );
      }
      if (inserted === "inserted") {
        appendTransitionEvent(db, {
          record,
          fromState: null,
          event: "DELEGATION_ESTABLISHED",
          actorKind: "host",
          actorRef: params.hostActorRef ?? "openclaw.host.delegation",
          authorityRef: null,
        });
      }
      return {
        kind: inserted === "inserted" ? ("acquired" as const) : ("duplicate" as const),
        record,
      };
    },
    params.options ?? {},
    { operationLabel: "delegated-execution.ownership.acquire" },
  );
}

export type DelegateHandoffParams = Readonly<{
  delegationRef: string;
  ownerKind: string;
  ownerId: string;
  delegateGoalRef?: string | null;
  expectedRevision?: number;
  hostActorRef?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}>;

function readRequired(db: DatabaseSync, delegationRef: string): DelegatedExecutionOwnershipRecord {
  const record = readOwnershipRow(db, delegationRef);
  if (!record) {
    throw new DelegatedExecutionOwnershipRefusedError(
      "unknown-delegation-ref",
      "no ownership record exists for delegation_ref " + delegationRef,
    );
  }
  return record;
}

/** Host delegation_ref and delegate_goal_ref are distinct identities and never overloaded. */
export function recordDelegateOwnerUnavailable(
  params: DelegateHandoffParams,
): DelegatedExecutionOwnershipRecord {
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureDelegatedExecutionOwnershipSchema(db);
      const current = readRequired(db, params.delegationRef);
      const outcome = casOwnershipRow(db, {
        delegationRef: params.delegationRef,
        expectedState: current.state,
        expectedRevision: params.expectedRevision ?? current.revision,
        expectedOwnerKind: params.ownerKind,
        expectedOwnerId: params.ownerId,
        next: {
          state: "DELEGATED_LOCKED",
          ownerState: "unavailable",
          delegateGoalRef: params.delegateGoalRef ?? current.delegateGoalRef,
          authorityRef: current.authorityRef,
          lastEvent: "DELEGATE_OWNER_UNAVAILABLE",
          releaseEvent: null,
        },
        now,
      });
      const record = applyOutcome(outcome, {
        delegationRef: params.delegationRef,
        event: "DELEGATE_OWNER_UNAVAILABLE",
      });
      if (outcome.kind === "applied") {
        appendTransitionEvent(db, {
          record,
          fromState: current.state,
          event: "DELEGATE_OWNER_UNAVAILABLE",
          actorKind: "host",
          actorRef: params.hostActorRef ?? "openclaw.host.delegation",
          authorityRef: null,
        });
      }
      return record;
    },
    params.options ?? {},
    { operationLabel: "delegated-execution.ownership.owner-unavailable" },
  );
}

/** Successful handoff attaches the delegate's own goal identity and keeps the lock. */
export function recordDelegateOwnerAvailable(
  params: DelegateHandoffParams,
): DelegatedExecutionOwnershipRecord {
  if (!params.delegateGoalRef) {
    throw new DelegatedExecutionOwnershipRefusedError(
      "invalid-transition",
      "delegate owner handoff requires a distinct delegate_goal_ref",
    );
  }
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureDelegatedExecutionOwnershipSchema(db);
      const current = readRequired(db, params.delegationRef);
      const outcome = casOwnershipRow(db, {
        delegationRef: params.delegationRef,
        expectedState: current.state,
        expectedRevision: params.expectedRevision ?? current.revision,
        expectedOwnerKind: params.ownerKind,
        expectedOwnerId: params.ownerId,
        next: {
          state: "DELEGATED_LOCKED",
          ownerState: "available",
          delegateGoalRef: params.delegateGoalRef,
          authorityRef: current.authorityRef,
          lastEvent: "DELEGATE_OWNER_AVAILABLE",
          releaseEvent: null,
        },
        now,
      });
      const record = applyOutcome(outcome, {
        delegationRef: params.delegationRef,
        event: "DELEGATE_OWNER_AVAILABLE",
      });
      if (outcome.kind === "applied") {
        appendTransitionEvent(db, {
          record,
          fromState: current.state,
          event: "DELEGATE_OWNER_AVAILABLE",
          actorKind: "host",
          actorRef: params.hostActorRef ?? "openclaw.host.delegation",
          authorityRef: null,
        });
      }
      return record;
    },
    params.options ?? {},
    { operationLabel: "delegated-execution.ownership.owner-available" },
  );
}

/** Authorizes ordinary execution of exactly this delegated task by a trusted human. */
export function authorizeTrustedHumanFallback(params: {
  delegationRef: string;
  authority: unknown;
  ownerKind?: string;
  ownerId?: string;
  hostActorRef?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): DelegatedExecutionOwnershipRecord {
  const authority: TrustedHumanFallbackAuthority = requireTrustedHumanFallbackAuthority({
    authority: params.authority,
    delegationRef: params.delegationRef,
    intent: "fallback",
  });
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureDelegatedExecutionOwnershipSchema(db);
      const current = readRequired(db, params.delegationRef);
      const outcome = casOwnershipRow(db, {
        delegationRef: params.delegationRef,
        expectedState: current.state,
        expectedRevision: current.revision,
        expectedOwnerKind: params.ownerKind ?? current.ownerKind,
        expectedOwnerId: params.ownerId ?? current.ownerId,
        next: {
          state: "FALLBACK_AUTHORIZED",
          ownerState: current.ownerState,
          authorityRef: authority.authorityRef,
          lastEvent: "HUMAN_FALLBACK_AUTHORIZED",
          releaseEvent: null,
        },
        now,
      });
      const record = applyOutcome(outcome, {
        delegationRef: params.delegationRef,
        event: "HUMAN_FALLBACK_AUTHORIZED",
      });
      if (outcome.kind === "applied") {
        appendTransitionEvent(db, {
          record,
          fromState: current.state,
          event: "HUMAN_FALLBACK_AUTHORIZED",
          actorKind: "trusted-human",
          actorRef: params.hostActorRef ?? "openclaw.host.trusted-human",
          authorityRef: authority.authorityRef,
        });
      }
      return record;
    },
    params.options ?? {},
    { operationLabel: "delegated-execution.ownership.fallback-authorize" },
  );
}

export type TerminalOwnershipReleaseParams = Readonly<{
  delegationRef: string;
  event: DelegatedExecutionOwnershipTerminalEvent;
  actorKind: DelegatedExecutionOwnershipActorKind;
  actorRef: string;
  authorityRef?: string | null;
  ownerKind?: string;
  ownerId?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}>;

/**
 * The only release path. Terminal events and an authorized human revoke are the
 * complete set; timeouts, restarts, plugin failures, and model choices are not
 * representable here.
 */
export function releaseDelegatedExecutionOwnership(
  params: TerminalOwnershipReleaseParams,
): DelegatedExecutionOwnershipRecord {
  const now = params.now ?? Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      ensureDelegatedExecutionOwnershipSchema(db);
      const current = readRequired(db, params.delegationRef);
      const outcome = casOwnershipRow(db, {
        delegationRef: params.delegationRef,
        expectedState: current.state,
        expectedRevision: current.revision,
        expectedOwnerKind: params.ownerKind ?? current.ownerKind,
        expectedOwnerId: params.ownerId ?? current.ownerId,
        next: {
          state: "RELEASED",
          ownerState: current.ownerState,
          authorityRef: params.authorityRef ?? current.authorityRef,
          lastEvent: params.event,
          releaseEvent: params.event,
        },
        now,
      });
      const record = applyOutcome(outcome, {
        delegationRef: params.delegationRef,
        event: params.event,
      });
      if (outcome.kind === "applied") {
        appendTransitionEvent(db, {
          record,
          fromState: current.state,
          event: params.event,
          actorKind: params.actorKind,
          actorRef: params.actorRef,
          authorityRef: params.authorityRef ?? null,
        });
      }
      return record;
    },
    params.options ?? {},
    { operationLabel: "delegated-execution.ownership.release" },
  );
}

/** Human revoke uses the same authority strength as fallback authorization. */
export function revokeDelegatedExecutionOwnership(params: {
  delegationRef: string;
  authority: unknown;
  actorRef?: string;
  now?: number;
  options?: OpenClawStateDatabaseOptions;
}): DelegatedExecutionOwnershipRecord {
  const authority = requireTrustedHumanFallbackAuthority({
    authority: params.authority,
    delegationRef: params.delegationRef,
    intent: "revoke",
  });
  return releaseDelegatedExecutionOwnership({
    delegationRef: params.delegationRef,
    event: "HUMAN_REVOKED_DELEGATION",
    actorKind: "trusted-human",
    actorRef: params.actorRef ?? "openclaw.host.trusted-human",
    authorityRef: authority.authorityRef,
    ...(params.now === undefined ? {} : { now: params.now }),
    ...(params.options === undefined ? {} : { options: params.options }),
  });
}

/** Fails closed: an unusable registry is never reported as DIRECT. */
export function readDelegatedExecutionOwnership(params: {
  db: DatabaseSync;
  delegationRef: string;
}): DelegatedExecutionOwnershipLookup {
  try {
    const record = readOwnershipRow(params.db, params.delegationRef);
    return record ? { kind: "owned", record } : { kind: "direct" };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof Error ? error.message : "ownership registry read failed",
    };
  }
}

export function listLiveDelegatedExecutionOwnership(params: {
  db: DatabaseSync;
}): DelegatedExecutionOwnershipRecord[] {
  return listLiveOwnershipRows(params.db);
}
