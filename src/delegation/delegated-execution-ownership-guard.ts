/**
 * Host-owned execution enforcement points.
 *
 * Two independent checks repeat the same ownership decision: one before
 * ordinary agent/model execution starts and one before a real tool executes.
 * Both are Host code, so a missing plugin or an absent handler cannot remove
 * enforcement.
 */
import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  openDelegatedExecutionOwnershipRegistry,
  listLiveDelegatedExecutionOwnership,
} from "./delegated-execution-ownership.js";
import {
  DELEGATED_EXECUTION_OWNERSHIP_LIVE_STATES,
  DELEGATED_EXECUTION_OWNERSHIP_STATES,
  type DelegatedExecutionOwnershipRecord,
  type DelegatedExecutionOwnershipState,
} from "./delegated-execution-ownership.types.js";
import { requireTrustedHumanFallbackAuthority } from "./trusted-human-fallback-authority.js";

export type DelegatedExecutionAdmissionDenialCode =
  | "delegated-ownership-locked"
  | "ownership-unreadable"
  | "ownership-conflict"
  | "fallback-authority-required";

export type DelegatedExecutionAdmission =
  | { allowed: true; reason: "direct" | "released" | "human-fallback-authorized" }
  | {
      allowed: false;
      code: DelegatedExecutionAdmissionDenialCode;
      reason: string;
      delegationRef: string | null;
    };

export type DelegatedExecutionAdmissionParams = Readonly<{
  db?: DatabaseSync;
  options?: OpenClawStateDatabaseOptions;
  delegationRef?: string | null;
  lineageRef?: string | null;
  fallbackAuthority?: unknown;
}>;

function isPersistedState(value: string): value is DelegatedExecutionOwnershipState {
  return (DELEGATED_EXECUTION_OWNERSHIP_STATES as readonly string[]).includes(value);
}

function isLive(record: DelegatedExecutionOwnershipRecord): boolean {
  return (DELEGATED_EXECUTION_OWNERSHIP_LIVE_STATES as readonly string[]).includes(record.state);
}

function deny(
  code: DelegatedExecutionAdmissionDenialCode,
  reason: string,
  delegationRef: string | null,
): DelegatedExecutionAdmission {
  return { allowed: false, code, reason, delegationRef };
}

type OwnershipResolution =
  | { kind: "records"; records: DelegatedExecutionOwnershipRecord[] }
  | { kind: "unreadable"; reason: string }
  | { kind: "conflict"; reason: string; delegationRef: string | null };

function resolveOwnership(
  db: DatabaseSync,
  params: DelegatedExecutionAdmissionParams,
): OwnershipResolution {
  try {
    // Prove the registry is readable before reporting DIRECT. An unreadable
    // registry can never be read as "no delegated work here".
    const live = listLiveDelegatedExecutionOwnership({ db });
    if (params.delegationRef) {
      return {
        kind: "records",
        records: live.filter((record) => record.delegationRef === params.delegationRef),
      };
    }
    const lineageRef = params.lineageRef;
    if (lineageRef) {
      // Ownership is task-scoped: only proven lineage inherits it.
      const inherited = live.filter((record) => record.lineageRef === lineageRef);
      if (inherited.length > 1) {
        return {
          kind: "conflict",
          reason: "multiple live ownership rows claim this execution lineage",
          delegationRef: null,
        };
      }
      return { kind: "records", records: inherited };
    }
    // Unrelated runs sharing user, agent, workspace, Gateway, or session do not
    // inherit: without a proven relation the scope claim is empty.
    return { kind: "records", records: [] };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : "ownership registry read failed",
    };
  }
}

function decide(
  resolution: OwnershipResolution,
  params: DelegatedExecutionAdmissionParams,
): DelegatedExecutionAdmission {
  if (resolution.kind === "unreadable") {
    return deny("ownership-unreadable", resolution.reason, null);
  }
  if (resolution.kind === "conflict") {
    return deny("ownership-conflict", resolution.reason, resolution.delegationRef);
  }
  const record = resolution.records[0];
  if (!record) {
    return { allowed: true, reason: "direct" };
  }
  if (!isPersistedState(record.state)) {
    return deny(
      "ownership-conflict",
      "retained ownership row carries an unknown state",
      record.delegationRef,
    );
  }
  if (record.state === "RELEASED") {
    return { allowed: true, reason: "released" };
  }
  if (record.state === "DELEGATED_LOCKED") {
    return deny(
      "delegated-ownership-locked",
      "delegated work is still owned by " + record.ownerKind + ":" + record.ownerId,
      record.delegationRef,
    );
  }
  // FALLBACK_AUTHORIZED: ordinary execution is allowed only under a live Host
  // authority bound to this exact delegation_ref.
  try {
    requireTrustedHumanFallbackAuthority({
      authority: params.fallbackAuthority,
      delegationRef: record.delegationRef,
      intent: "fallback",
    });
    return { allowed: true, reason: "human-fallback-authorized" };
  } catch (error) {
    return deny(
      "fallback-authority-required",
      error instanceof Error ? error.message : "trusted human fallback authority is required",
      record.delegationRef,
    );
  }
}

function withRegistry(
  params: DelegatedExecutionAdmissionParams,
  run: (db: DatabaseSync) => DelegatedExecutionAdmission,
): DelegatedExecutionAdmission {
  if (params.db) {
    return run(params.db);
  }
  try {
    return run(openDelegatedExecutionOwnershipRegistry(params.options ?? {}).db);
  } catch (error) {
    return deny(
      "ownership-unreadable",
      error instanceof Error ? error.message : "ownership registry is unavailable",
      null,
    );
  }
}

/** A) Before ordinary model/agent execution starts. */
export function admitAgentExecution(
  params: DelegatedExecutionAdmissionParams,
): DelegatedExecutionAdmission {
  return withRegistry(params, (db) => decide(resolveOwnership(db, params), params));
}

/** B) Before any real tool or capability executes; repeats the ownership check. */
export function admitToolExecution(
  params: DelegatedExecutionAdmissionParams,
): DelegatedExecutionAdmission {
  return withRegistry(params, (db) => decide(resolveOwnership(db, params), params));
}

/** Child execution inherits ownership only when lineage proves the relation. */
export function inheritDelegatedExecutionOwnership(params: {
  parentLineageRef: string;
  childLineageRef: string;
}): { lineageRef: string } {
  return { lineageRef: params.childLineageRef || params.parentLineageRef };
}
