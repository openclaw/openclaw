// Durable exact-target fences used to divert only newly admitted model work.
import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as StateDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";

type FenceDatabase = Pick<
  StateDatabase,
  "model_target_fences" | "model_target_fence_denials" | "model_submission_permits"
>;

export type ModelTargetFenceTarget = { provider: string; model: string };
export type ModelTargetFence = {
  provider: string;
  model: string;
  topologyGeneration: string;
  fenceEpoch: number;
  fenceToken: string;
  mode: "divert_new" | "prepare_recovery";
  state: "active" | "prepared" | "released";
  resourceDomain: string | null;
  deniedTargets: ModelTargetFenceTarget[];
  createdAtMs: number;
  preparedAtMs: number | null;
  generationGoneAtMs: number | null;
  releasedAtMs: number | null;
};
export type DivertNewModelTargetParams = ModelTargetFenceTarget & {
  topologyGeneration: string;
  fenceEpoch: number;
  fenceToken: string;
  resourceDomain?: string;
  deniedTargets?: readonly ModelTargetFenceTarget[];
  nowMs?: number;
};
export type ReleaseModelTargetFenceParams = ModelTargetFenceTarget & {
  topologyGeneration: string;
  fenceEpoch: number;
  fenceToken: string;
  nowMs?: number;
};
export type PrepareRecoveryModelTargetParams = DivertNewModelTargetParams & {
  generationGoneProof?: string;
};
export type ModelTargetFenceStore = {
  status: () => { activeFences: ModelTargetFence[] };
  divertNew: (params: DivertNewModelTargetParams) => ModelTargetFence;
  prepareRecovery: (params: PrepareRecoveryModelTargetParams) => ModelTargetFence;
  release: (params: ReleaseModelTargetFenceParams) => ModelTargetFence;
};

export class ModelTargetFenceStaleError extends Error {
  readonly code = "MODEL_TARGET_FENCE_STALE";
}
export class ModelTargetFenceConflictError extends Error {
  readonly code = "MODEL_TARGET_FENCE_CONFLICT";
}

function normalizeTarget(target: ModelTargetFenceTarget): ModelTargetFenceTarget {
  const normalized = {
    provider: target.provider.trim().toLowerCase(),
    model: target.model.trim(),
  };
  if (!normalized.provider || !normalized.model) {
    throw new Error("model target provider and model must not be blank");
  }
  return normalized;
}

function readFence(
  database: DatabaseSync,
  target: ModelTargetFenceTarget & { topologyGeneration: string; fenceEpoch: number },
): ModelTargetFence | null {
  const db = getNodeSqliteKysely<FenceDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("model_target_fences")
      .selectAll()
      .where("provider", "=", target.provider)
      .where("model", "=", target.model)
      .where("topology_generation", "=", target.topologyGeneration)
      .where("fence_epoch", "=", target.fenceEpoch),
  );
  if (!row) {
    return null;
  }
  const deniedTargets = executeSqliteQuerySync(
    database,
    db
      .selectFrom("model_target_fence_denials")
      .select(["denied_provider", "denied_model"])
      .where("provider", "=", row.provider)
      .where("model", "=", row.model)
      .where("topology_generation", "=", row.topology_generation)
      .where("fence_epoch", "=", row.fence_epoch)
      .orderBy("denied_provider")
      .orderBy("denied_model"),
  ).rows.map((denial) => ({
    provider: denial.denied_provider,
    model: denial.denied_model,
  }));
  return {
    provider: row.provider,
    model: row.model,
    topologyGeneration: row.topology_generation,
    fenceEpoch: row.fence_epoch,
    fenceToken: row.fence_token,
    mode: row.mode === "prepare_recovery" ? "prepare_recovery" : "divert_new",
    state: row.state === "active" ? "active" : row.state === "prepared" ? "prepared" : "released",
    resourceDomain: row.resource_domain,
    deniedTargets,
    createdAtMs: row.created_at_ms,
    preparedAtMs: row.prepared_at_ms,
    generationGoneAtMs: row.generation_gone_at_ms,
    releasedAtMs: row.released_at_ms,
  };
}

export function createModelTargetFenceStore(
  options: OpenClawStateDatabaseOptions = {},
): ModelTargetFenceStore {
  return {
    status: () => {
      const database = openOpenClawStateDatabase(options).db;
      const db = getNodeSqliteKysely<FenceDatabase>(database);
      const active = executeSqliteQuerySync(
        database,
        db
          .selectFrom("model_target_fences")
          .select(["provider", "model", "topology_generation", "fence_epoch"])
          .where("state", "!=", "released")
          .orderBy("provider")
          .orderBy("model"),
      ).rows;
      return {
        activeFences: active.flatMap((row) => {
          const fence = readFence(database, {
            provider: row.provider,
            model: row.model,
            topologyGeneration: row.topology_generation,
            fenceEpoch: row.fence_epoch,
          });
          return fence ? [fence] : [];
        }),
      };
    },
    divertNew: (params) =>
      runOpenClawStateWriteTransaction(
        (database) => {
          const target = normalizeTarget(params);
          const topologyGeneration = params.topologyGeneration.trim();
          const fenceToken = params.fenceToken.trim();
          if (
            !topologyGeneration ||
            !fenceToken ||
            !Number.isSafeInteger(params.fenceEpoch) ||
            params.fenceEpoch < 1
          ) {
            throw new Error("model target fence identity is invalid");
          }
          const db = getNodeSqliteKysely<FenceDatabase>(database.db);
          const latest = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_target_fences")
              .select(["fence_epoch", "fence_token", "state"])
              .where("provider", "=", target.provider)
              .where("model", "=", target.model)
              .where("topology_generation", "=", topologyGeneration)
              .orderBy("fence_epoch", "desc")
              .limit(1),
          );
          if (
            latest?.fence_epoch === params.fenceEpoch &&
            latest.fence_token === fenceToken &&
            latest.state === "active"
          ) {
            const existing = readFence(database.db, {
              ...target,
              topologyGeneration,
              fenceEpoch: params.fenceEpoch,
            });
            if (existing) {
              return existing;
            }
          }
          if (latest && params.fenceEpoch <= latest.fence_epoch) {
            throw new ModelTargetFenceStaleError("model target fence epoch is stale");
          }
          const active = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_target_fences")
              .select("fence_epoch")
              .where("provider", "=", target.provider)
              .where("model", "=", target.model)
              .where("state", "!=", "released"),
          );
          if (active) {
            throw new ModelTargetFenceConflictError("model target already has an active fence");
          }
          const nowMs = params.nowMs ?? Date.now();
          executeSqliteQuerySync(
            database.db,
            db.insertInto("model_target_fences").values({
              provider: target.provider,
              model: target.model,
              topology_generation: topologyGeneration,
              fence_epoch: params.fenceEpoch,
              fence_token: fenceToken,
              mode: "divert_new",
              state: "active",
              resource_domain: params.resourceDomain?.trim() || null,
              created_at_ms: nowMs,
              prepared_at_ms: null,
              generation_gone_at_ms: null,
              generation_gone_proof: null,
              released_at_ms: null,
            }),
          );
          const denials = new Map<string, ModelTargetFenceTarget>();
          for (const deniedTarget of params.deniedTargets ?? []) {
            const denied = normalizeTarget(deniedTarget);
            denials.set(`${denied.provider}\u0000${denied.model}`, denied);
          }
          for (const denied of denials.values()) {
            executeSqliteQuerySync(
              database.db,
              db.insertInto("model_target_fence_denials").values({
                provider: target.provider,
                model: target.model,
                topology_generation: topologyGeneration,
                fence_epoch: params.fenceEpoch,
                denied_provider: denied.provider,
                denied_model: denied.model,
              }),
            );
          }
          const created = readFence(database.db, {
            ...target,
            topologyGeneration,
            fenceEpoch: params.fenceEpoch,
          });
          if (!created) {
            throw new Error("model target fence was not persisted");
          }
          return created;
        },
        options,
        { operationLabel: "model-recovery.divert-new" },
      ),
    prepareRecovery: (params) =>
      runOpenClawStateWriteTransaction(
        (database) => {
          const target = normalizeTarget(params);
          const topologyGeneration = params.topologyGeneration.trim();
          const fenceToken = params.fenceToken.trim();
          const generationGoneProof = params.generationGoneProof?.trim() || null;
          if (
            !topologyGeneration ||
            !fenceToken ||
            !Number.isSafeInteger(params.fenceEpoch) ||
            params.fenceEpoch < 1
          ) {
            throw new Error("model target fence identity is invalid");
          }
          const db = getNodeSqliteKysely<FenceDatabase>(database.db);
          const exact = readFence(database.db, {
            ...target,
            topologyGeneration,
            fenceEpoch: params.fenceEpoch,
          });
          if (exact && exact.fenceToken !== fenceToken) {
            throw new ModelTargetFenceStaleError("model target fence token is stale");
          }
          if (exact?.mode === "prepare_recovery" && exact.state === "prepared") {
            return exact;
          }
          const latest = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_target_fences")
              .select(["fence_epoch", "fence_token", "state"])
              .where("provider", "=", target.provider)
              .where("model", "=", target.model)
              .orderBy("fence_epoch", "desc")
              .limit(1),
          );
          if (!exact && latest && params.fenceEpoch <= latest.fence_epoch) {
            throw new ModelTargetFenceStaleError("model target fence epoch is stale");
          }
          if (!exact && latest?.state !== "released") {
            throw new ModelTargetFenceConflictError("model target already has an active fence");
          }
          const nowMs = params.nowMs ?? Date.now();
          if (!exact) {
            executeSqliteQuerySync(
              database.db,
              db.insertInto("model_target_fences").values({
                provider: target.provider,
                model: target.model,
                topology_generation: topologyGeneration,
                fence_epoch: params.fenceEpoch,
                fence_token: fenceToken,
                mode: "prepare_recovery",
                state: "active",
                resource_domain: params.resourceDomain?.trim() || null,
                created_at_ms: nowMs,
                prepared_at_ms: null,
                generation_gone_at_ms: null,
                generation_gone_proof: null,
                released_at_ms: null,
              }),
            );
          } else if (exact.state === "released") {
            throw new ModelTargetFenceStaleError("released model target fence cannot be prepared");
          } else {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("model_target_fences")
                .set({ mode: "prepare_recovery" })
                .where("provider", "=", target.provider)
                .where("model", "=", target.model)
                .where("topology_generation", "=", topologyGeneration)
                .where("fence_epoch", "=", params.fenceEpoch)
                .where("fence_token", "=", fenceToken),
            );
          }
          const denials = new Map<string, ModelTargetFenceTarget>();
          for (const deniedTarget of params.deniedTargets ?? []) {
            const denied = normalizeTarget(deniedTarget);
            denials.set(`${denied.provider}\u0000${denied.model}`, denied);
          }
          for (const denied of denials.values()) {
            executeSqliteQuerySync(
              database.db,
              db
                .insertInto("model_target_fence_denials")
                .values({
                  provider: target.provider,
                  model: target.model,
                  topology_generation: topologyGeneration,
                  fence_epoch: params.fenceEpoch,
                  denied_provider: denied.provider,
                  denied_model: denied.model,
                })
                .onConflict((conflict) => conflict.doNothing()),
            );
          }
          if (generationGoneProof) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("model_submission_permits")
                .set({ state: "reconciled", reconciled_at_ms: nowMs })
                .where("provider", "=", target.provider)
                .where("model", "=", target.model)
                .where("topology_generation", "=", topologyGeneration)
                .where("state", "=", "active"),
            );
          }
          const activePermit = executeSqliteQueryTakeFirstSync(
            database.db,
            db
              .selectFrom("model_submission_permits")
              .select("permit_id")
              .where("provider", "=", target.provider)
              .where("model", "=", target.model)
              .where("topology_generation", "=", topologyGeneration)
              .where("state", "=", "active")
              .limit(1),
          );
          if (!activePermit) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("model_target_fences")
                .set({
                  state: "prepared",
                  prepared_at_ms: nowMs,
                  generation_gone_at_ms: generationGoneProof ? nowMs : null,
                  generation_gone_proof: generationGoneProof,
                })
                .where("provider", "=", target.provider)
                .where("model", "=", target.model)
                .where("topology_generation", "=", topologyGeneration)
                .where("fence_epoch", "=", params.fenceEpoch)
                .where("fence_token", "=", fenceToken)
                .where("mode", "=", "prepare_recovery")
                .where("state", "=", "active"),
            );
          }
          const prepared = readFence(database.db, {
            ...target,
            topologyGeneration,
            fenceEpoch: params.fenceEpoch,
          });
          if (!prepared) {
            throw new Error("prepared model target fence is unavailable");
          }
          return prepared;
        },
        options,
        { operationLabel: "model-recovery.prepare" },
      ),
    release: (params) =>
      runOpenClawStateWriteTransaction(
        (database) => {
          const target = normalizeTarget(params);
          const topologyGeneration = params.topologyGeneration.trim();
          const fenceToken = params.fenceToken.trim();
          const db = getNodeSqliteKysely<FenceDatabase>(database.db);
          const existing = readFence(database.db, {
            ...target,
            topologyGeneration,
            fenceEpoch: params.fenceEpoch,
          });
          if (existing?.fenceToken === fenceToken && existing.state === "released") {
            return existing;
          }
          if (existing?.mode === "prepare_recovery") {
            throw new ModelTargetFenceConflictError(
              "prepared recovery fence requires replay-aware release",
            );
          }
          const result = executeSqliteQuerySync(
            database.db,
            db
              .updateTable("model_target_fences")
              .set({ state: "released", released_at_ms: params.nowMs ?? Date.now() })
              .where("provider", "=", target.provider)
              .where("model", "=", target.model)
              .where("topology_generation", "=", topologyGeneration)
              .where("fence_epoch", "=", params.fenceEpoch)
              .where("fence_token", "=", fenceToken)
              .where("state", "!=", "released"),
          );
          if ((result.numAffectedRows ?? 0n) !== 1n) {
            throw new ModelTargetFenceStaleError("model target fence release token is stale");
          }
          const released = readFence(database.db, {
            ...target,
            topologyGeneration,
            fenceEpoch: params.fenceEpoch,
          });
          if (!released) {
            throw new Error("released model target fence is unavailable");
          }
          return released;
        },
        options,
        { operationLabel: "model-recovery.release" },
      ),
  };
}
