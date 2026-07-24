// Durable global authority for one active provider submission per logical turn.
import { randomUUID } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as StateDatabase } from "./openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

type PermitDatabase = Pick<StateDatabase, "model_submission_permits" | "model_target_fences">;

export type ModelSubmissionPermit = {
  permitId: string;
  agentId: string;
  logicalTurnId: string;
  attemptEpoch: number;
  ownerId: string;
  runId: string;
  provider: string;
  model: string;
  topologyGeneration: string;
  fenceEpoch: number;
  fenceToken: string;
  state: "active" | "terminal" | "reconciled";
  issuedAtMs: number;
};

export type IssueModelSubmissionPermitResult =
  | { issued: true; permit: ModelSubmissionPermit }
  | { issued: false; reason: "fenced" | "owned" | "terminal" | "unmanaged" };

export type ModelSubmissionPermitStore = {
  issue: (params: {
    agentId: string;
    logicalTurnId: string;
    attemptEpoch: number;
    ownerId: string;
    runId: string;
    provider: string;
    model: string;
    nowMs?: number;
  }) => IssueModelSubmissionPermitResult;
  complete: (params: {
    permitId: string;
    nowMs?: number;
  }) => { completed: true } | { completed: false; reason: "missing" | "stale" };
};

function requireIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${field} must not be blank`);
  }
  return normalized;
}

function toPermit(row: StateDatabase["model_submission_permits"]): ModelSubmissionPermit {
  return {
    permitId: row.permit_id,
    agentId: row.agent_id,
    logicalTurnId: row.logical_turn_id,
    attemptEpoch: row.attempt_epoch,
    ownerId: row.owner_id,
    runId: row.run_id,
    provider: row.provider,
    model: row.model,
    topologyGeneration: row.topology_generation,
    fenceEpoch: row.fence_epoch,
    fenceToken: row.fence_token,
    state: row.state === "active" ? "active" : row.state === "terminal" ? "terminal" : "reconciled",
    issuedAtMs: row.issued_at_ms,
  };
}

export function createModelSubmissionPermitStore(
  options: OpenClawStateDatabaseOptions = {},
): ModelSubmissionPermitStore {
  return {
    issue: (params) =>
      runOpenClawStateWriteTransaction(
        (database) => {
          const agentId = requireIdentity(params.agentId, "agentId");
          const logicalTurnId = requireIdentity(params.logicalTurnId, "logicalTurnId");
          const ownerId = requireIdentity(params.ownerId, "ownerId");
          const runId = requireIdentity(params.runId, "runId");
          const provider = requireIdentity(params.provider, "provider").toLowerCase();
          const model = requireIdentity(params.model, "model");
          if (!Number.isSafeInteger(params.attemptEpoch) || params.attemptEpoch < 1) {
            throw new Error("attemptEpoch must be a positive safe integer");
          }
          const db = getNodeSqliteKysely<PermitDatabase>(database.db);
          const activeOwner = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_submission_permits")
              .selectAll()
              .where("logical_turn_id", "=", logicalTurnId)
              .where("state", "=", "active")
              .limit(1),
          );
          if (activeOwner) {
            if (
              activeOwner.attempt_epoch === params.attemptEpoch &&
              activeOwner.owner_id === ownerId &&
              activeOwner.run_id === runId &&
              activeOwner.provider === provider &&
              activeOwner.model === model
            ) {
              return { issued: true, permit: toPermit(activeOwner) };
            }
            return { issued: false, reason: "owned" };
          }
          const prior = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_submission_permits")
              .selectAll()
              .where("logical_turn_id", "=", logicalTurnId)
              .where("attempt_epoch", "=", params.attemptEpoch)
              .where("provider", "=", provider)
              .where("model", "=", model)
              .orderBy("issued_at_ms", "desc")
              .limit(1),
          );
          if (prior) {
            return prior.state === "active"
              ? { issued: true, permit: toPermit(prior) }
              : { issued: false, reason: "terminal" };
          }
          const fence = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_target_fences")
              .selectAll()
              .where("provider", "=", provider)
              .where("model", "=", model)
              .orderBy("fence_epoch", "desc")
              .limit(1),
          );
          if (!fence) {
            return { issued: false, reason: "unmanaged" };
          }
          if (fence.state !== "released" || fence.mode === "prepare_recovery") {
            return { issued: false, reason: "fenced" };
          }
          const permit: ModelSubmissionPermit = {
            permitId: randomUUID(),
            agentId,
            logicalTurnId,
            attemptEpoch: params.attemptEpoch,
            ownerId,
            runId,
            provider,
            model,
            topologyGeneration: fence.topology_generation,
            fenceEpoch: fence.fence_epoch,
            fenceToken: fence.fence_token,
            state: "active",
            issuedAtMs: params.nowMs ?? Date.now(),
          };
          executeSqliteQuerySync(
            database.db,
            db.insertInto("model_submission_permits").values({
              permit_id: permit.permitId,
              agent_id: permit.agentId,
              logical_turn_id: permit.logicalTurnId,
              attempt_epoch: permit.attemptEpoch,
              owner_id: permit.ownerId,
              run_id: permit.runId,
              provider: permit.provider,
              model: permit.model,
              topology_generation: permit.topologyGeneration,
              fence_epoch: permit.fenceEpoch,
              fence_token: permit.fenceToken,
              state: "active",
              issued_at_ms: permit.issuedAtMs,
              terminal_at_ms: null,
              reconciled_at_ms: null,
            }),
          );
          return { issued: true, permit };
        },
        options,
        { operationLabel: "model-recovery.issue-permit" },
      ),
    complete: (params) =>
      runOpenClawStateWriteTransaction(
        (database) => {
          const permitId = requireIdentity(params.permitId, "permitId");
          const db = getNodeSqliteKysely<PermitDatabase>(database.db);
          const permit = executeSqliteQueryTakeFirstSync(
            database.db,
            db.selectFrom("model_submission_permits").selectAll().where("permit_id", "=", permitId),
          );
          if (!permit) {
            return { completed: false, reason: "missing" };
          }
          if (permit.state === "terminal") {
            return { completed: true };
          }
          if (permit.state !== "active") {
            return { completed: false, reason: "stale" };
          }
          const nowMs = params.nowMs ?? Date.now();
          const result = executeSqliteQuerySync(
            database.db,
            db
              .updateTable("model_submission_permits")
              .set({ state: "terminal", terminal_at_ms: nowMs })
              .where("permit_id", "=", permitId)
              .where("state", "=", "active"),
          );
          if ((result.numAffectedRows ?? 0n) !== 1n) {
            return { completed: false, reason: "stale" };
          }
          const remaining = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_submission_permits")
              .select("permit_id")
              .where("provider", "=", permit.provider)
              .where("model", "=", permit.model)
              .where("topology_generation", "=", permit.topology_generation)
              .where("state", "=", "active")
              .limit(1),
          );
          if (!remaining) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("model_target_fences")
                .set({ state: "prepared", prepared_at_ms: nowMs })
                .where("provider", "=", permit.provider)
                .where("model", "=", permit.model)
                .where("topology_generation", "=", permit.topology_generation)
                .where("mode", "=", "prepare_recovery")
                .where("state", "=", "active"),
            );
          }
          return { completed: true };
        },
        options,
        { operationLabel: "model-recovery.complete-permit" },
      ),
  };
}
