import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  META_STEP_KINDS,
  type MetaRunStatus,
  type MetaStepKind,
  type MetaStepStatus,
} from "./types.js";

const META_RUN_STATUSES = new Set<MetaRunStatus>([
  "running",
  "succeeded",
  "failed",
  "paused",
  "cancelled",
]);

const META_STEP_STATUSES = new Set<MetaStepStatus>([
  "pending",
  "running",
  "succeeded",
  "skipped",
  "failed",
  "paused",
]);

const META_PAUSE_STATUS_VALUES = ["pending", "resumed", "expired", "cancelled"] as const;
const META_PAUSE_STATUSES = new Set<MetaPauseStatus>(META_PAUSE_STATUS_VALUES);

const META_STEP_KIND_SET = new Set<MetaStepKind>(META_STEP_KINDS);

export type JsonRecord = Record<string, unknown>;
export type MetaPauseStatus = (typeof META_PAUSE_STATUS_VALUES)[number];

export type MetaRunStoreRunRecord = {
  runId: string;
  skillName: string;
  agentId: string | null;
  sessionKey: string | null;
  status: MetaRunStatus;
  triggerJson: JsonRecord | null;
  inputJson: JsonRecord;
  finalText: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  completedAtMs: number | null;
};

export type MetaRunStorePauseRecord = {
  pauseId: string;
  runId: string;
  stepId: string;
  schemaJson: JsonRecord;
  prefillJson: JsonRecord | null;
  confirmedFieldsJson: JsonRecord | null;
  sessionKey: string;
  status: MetaPauseStatus;
  expiresAtMs: number;
  createdAtMs: number;
  resumedAtMs: number | null;
};

export type MetaRunStoreEvidenceRecord = {
  evidenceId: string;
  runId: string;
  stepId: string | null;
  proposalId: string | null;
  gateName: string;
  result: string;
  riskLevel: string | null;
  evidenceJson: JsonRecord;
  createdAtMs: number;
};

export type MetaRunStore = {
  recordRunStarted(params: {
    runId: string;
    skillName: string;
    agentId?: string;
    sessionKey?: string;
    inputJson: JsonRecord;
    triggerJson?: JsonRecord;
    createdAtMs: number;
  }): void;
  recordRunCompleted(params: {
    runId: string;
    status: Exclude<MetaRunStatus, "running">;
    finalText?: string;
    completedAtMs: number;
  }): void;
  recordStepFinished(params: {
    runId: string;
    stepId: string;
    kind: MetaStepKind;
    status: MetaStepStatus;
    inputJson?: JsonRecord;
    outputJson?: JsonRecord;
    errorJson?: JsonRecord;
    updatedAtMs: number;
  }): void;
  recordPause(params: {
    pauseId: string;
    runId: string;
    stepId: string;
    schemaJson: JsonRecord;
    sessionKey: string;
    expiresAtMs: number;
    createdAtMs: number;
    prefillJson?: JsonRecord;
    confirmedFieldsJson?: JsonRecord;
  }): void;
  recordEvidence(params: {
    evidenceId: string;
    runId: string;
    stepId?: string;
    proposalId?: string;
    gateName: string;
    result: string;
    riskLevel?: string;
    evidenceJson: JsonRecord;
    createdAtMs: number;
  }): void;
  readRun(runId: string): MetaRunStoreRunRecord | null;
  readPendingPauseForSession(sessionKey: string, nowMs?: number): MetaRunStorePauseRecord | null;
  listEvidence(runId: string): MetaRunStoreEvidenceRecord[];
};

type MetaSkillRunsTable = OpenClawStateKyselyDatabase["meta_skill_runs"];
type MetaSkillStepsTable = OpenClawStateKyselyDatabase["meta_skill_steps"];
type MetaSkillPausesTable = OpenClawStateKyselyDatabase["meta_skill_pauses"];
type MetaSkillEvidenceTable = OpenClawStateKyselyDatabase["meta_skill_evidence"];
type MetaRunStoreDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "meta_skill_runs" | "meta_skill_steps" | "meta_skill_pauses" | "meta_skill_evidence"
>;
type MetaRunRow = Selectable<MetaSkillRunsTable>;
type MetaPauseRow = Selectable<MetaSkillPausesTable>;
type MetaEvidenceRow = Selectable<MetaSkillEvidenceTable>;

function getMetaRunStoreKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<MetaRunStoreDatabase>(db);
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeJsonRecord(columnName: string, value: JsonRecord): string {
  if (!isJsonRecord(value)) {
    throw new Error(`Meta run store ${columnName} must be a JSON object.`);
  }
  return JSON.stringify(value);
}

function serializeOptionalJsonRecord(
  columnName: string,
  value: JsonRecord | undefined,
): string | null {
  if (value === undefined) {
    return null;
  }
  return serializeJsonRecord(columnName, value);
}

function parseJsonRecord(columnName: string, raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJsonRecord(parsed)) {
      throw new Error(`Meta run store ${columnName} must contain a JSON object.`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message.includes("must contain a JSON object")) {
      throw error;
    }
    throw new Error(`Meta run store ${columnName} contains invalid JSON.`, { cause: error });
  }
}

function parseOptionalJsonRecord(columnName: string, raw: string | null): JsonRecord | null {
  if (raw === null) {
    return null;
  }
  return parseJsonRecord(columnName, raw);
}

function parseRunStatus(status: string): MetaRunStatus {
  if (!META_RUN_STATUSES.has(status as MetaRunStatus)) {
    throw new Error(`Meta run store run status "${status}" is invalid.`);
  }
  return status as MetaRunStatus;
}

function parseStepKind(kind: string): MetaStepKind {
  if (!META_STEP_KIND_SET.has(kind as MetaStepKind)) {
    throw new Error(`Meta run store step kind "${kind}" is invalid.`);
  }
  return kind as MetaStepKind;
}

function parseStepStatus(status: string): MetaStepStatus {
  if (!META_STEP_STATUSES.has(status as MetaStepStatus)) {
    throw new Error(`Meta run store step status "${status}" is invalid.`);
  }
  return status as MetaStepStatus;
}

function parsePauseStatus(status: string): MetaPauseStatus {
  if (!META_PAUSE_STATUSES.has(status as MetaPauseStatus)) {
    throw new Error(`Meta run store pause status "${status}" is invalid.`);
  }
  return status as MetaPauseStatus;
}

function recordFromRunRow(row: MetaRunRow): MetaRunStoreRunRecord {
  return {
    runId: row.run_id,
    skillName: row.skill_name,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    status: parseRunStatus(row.status),
    triggerJson: parseOptionalJsonRecord("trigger_json", row.trigger_json),
    inputJson: parseJsonRecord("input_json", row.input_json),
    finalText: row.final_text,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    completedAtMs: row.completed_at_ms,
  };
}

function recordFromPauseRow(row: MetaPauseRow): MetaRunStorePauseRecord {
  return {
    pauseId: row.pause_id,
    runId: row.run_id,
    stepId: row.step_id,
    schemaJson: parseJsonRecord("schema_json", row.schema_json),
    prefillJson: parseOptionalJsonRecord("prefill_json", row.prefill_json),
    confirmedFieldsJson: parseOptionalJsonRecord(
      "confirmed_fields_json",
      row.confirmed_fields_json,
    ),
    sessionKey: row.session_key,
    status: parsePauseStatus(row.status),
    expiresAtMs: row.expires_at_ms,
    createdAtMs: row.created_at_ms,
    resumedAtMs: row.resumed_at_ms,
  };
}

function recordFromEvidenceRow(row: MetaEvidenceRow): MetaRunStoreEvidenceRecord {
  return {
    evidenceId: row.evidence_id,
    runId: row.run_id,
    stepId: row.step_id,
    proposalId: row.proposal_id,
    gateName: row.gate_name,
    result: row.result,
    riskLevel: row.risk_level,
    evidenceJson: parseJsonRecord("evidence_json", row.evidence_json),
    createdAtMs: row.created_at_ms,
  };
}

function resolveStepCompletedAtMs(status: MetaStepStatus, updatedAtMs: number): number | null {
  return status === "pending" || status === "running" ? null : updatedAtMs;
}

function bumpRunUpdatedAt(db: DatabaseSync, runId: string, updatedAtMs: number): void {
  executeSqliteQuerySync(
    db,
    getMetaRunStoreKysely(db)
      .updateTable("meta_skill_runs")
      .set({ updated_at_ms: updatedAtMs })
      .where("run_id", "=", runId)
      .where("updated_at_ms", "<", updatedAtMs),
  );
}

function assertStepKindMatches(
  db: DatabaseSync,
  params: { runId: string; stepId: string; kind: MetaStepKind },
): void {
  const existing = executeSqliteQueryTakeFirstSync(
    db,
    getMetaRunStoreKysely(db)
      .selectFrom("meta_skill_steps")
      .select(["kind"])
      .where("run_id", "=", params.runId)
      .where("step_id", "=", params.stepId),
  );
  if (existing && existing.kind !== params.kind) {
    throw new Error(
      `Meta run store cannot change step "${params.stepId}" kind from "${existing.kind}" to "${params.kind}".`,
    );
  }
}

function requireAffectedRow(params: {
  numAffectedRows?: bigint;
  entityName: string;
  entityId: string;
  operation: string;
}): void {
  if (Number(params.numAffectedRows ?? 0n) > 0) {
    return;
  }
  throw new Error(
    `Meta run store could not ${params.operation} ${params.entityName} "${params.entityId}".`,
  );
}

function selectRun(db: DatabaseSync, runId: string): MetaRunStoreRunRecord | null {
  const row =
    executeSqliteQueryTakeFirstSync(
      db,
      getMetaRunStoreKysely(db)
        .selectFrom("meta_skill_runs")
        .select([
          "run_id",
          "skill_name",
          "agent_id",
          "session_key",
          "status",
          "trigger_json",
          "input_json",
          "final_text",
          "created_at_ms",
          "updated_at_ms",
          "completed_at_ms",
        ])
        .where("run_id", "=", runId),
    ) ?? null;
  return row ? recordFromRunRow(row) : null;
}

function selectPendingPauseForSession(
  db: DatabaseSync,
  sessionKey: string,
  nowMs: number,
): MetaRunStorePauseRecord | null {
  const row =
    executeSqliteQueryTakeFirstSync(
      db,
      getMetaRunStoreKysely(db)
        .selectFrom("meta_skill_pauses")
        .select([
          "pause_id",
          "run_id",
          "step_id",
          "schema_json",
          "prefill_json",
          "confirmed_fields_json",
          "session_key",
          "status",
          "expires_at_ms",
          "created_at_ms",
          "resumed_at_ms",
        ])
        .where("session_key", "=", sessionKey)
        .where("status", "=", "pending")
        .where("resumed_at_ms", "is", null)
        .where("expires_at_ms", ">", nowMs)
        .orderBy("created_at_ms", "desc")
        .orderBy("pause_id", "desc"),
    ) ?? null;
  return row ? recordFromPauseRow(row) : null;
}

function selectEvidence(db: DatabaseSync, runId: string): MetaRunStoreEvidenceRecord[] {
  return executeSqliteQuerySync(
    db,
    getMetaRunStoreKysely(db)
      .selectFrom("meta_skill_evidence")
      .select([
        "evidence_id",
        "run_id",
        "step_id",
        "proposal_id",
        "gate_name",
        "result",
        "risk_level",
        "evidence_json",
        "created_at_ms",
      ])
      .where("run_id", "=", runId)
      .orderBy("created_at_ms", "asc")
      .orderBy("evidence_id", "asc"),
  ).rows.map(recordFromEvidenceRow);
}

export function createMetaRunStore(options: OpenClawStateDatabaseOptions = {}): MetaRunStore {
  return {
    recordRunStarted(params) {
      runOpenClawStateWriteTransaction((database) => {
        const row: Insertable<MetaSkillRunsTable> = {
          run_id: params.runId,
          skill_name: params.skillName,
          agent_id: params.agentId ?? null,
          session_key: params.sessionKey ?? null,
          status: "running",
          trigger_json: serializeOptionalJsonRecord("trigger_json", params.triggerJson),
          input_json: serializeJsonRecord("input_json", params.inputJson),
          final_text: null,
          created_at_ms: params.createdAtMs,
          updated_at_ms: params.createdAtMs,
          completed_at_ms: null,
        };
        executeSqliteQuerySync(
          database.db,
          getMetaRunStoreKysely(database.db).insertInto("meta_skill_runs").values(row),
        );
      }, options);
    },

    recordRunCompleted(params) {
      runOpenClawStateWriteTransaction((database) => {
        const result = executeSqliteQuerySync(
          database.db,
          getMetaRunStoreKysely(database.db)
            .updateTable("meta_skill_runs")
            .set({
              status: params.status,
              final_text: params.finalText ?? null,
              updated_at_ms: params.completedAtMs,
              completed_at_ms: params.completedAtMs,
            })
            .where("run_id", "=", params.runId),
        );
        requireAffectedRow({
          numAffectedRows: result.numAffectedRows,
          entityName: "meta run",
          entityId: params.runId,
          operation: "complete",
        });
      }, options);
    },

    recordStepFinished(params) {
      parseStepKind(params.kind);
      parseStepStatus(params.status);
      runOpenClawStateWriteTransaction((database) => {
        assertStepKindMatches(database.db, {
          runId: params.runId,
          stepId: params.stepId,
          kind: params.kind,
        });
        const row: Insertable<MetaSkillStepsTable> = {
          run_id: params.runId,
          step_id: params.stepId,
          kind: params.kind,
          status: params.status,
          input_json: serializeOptionalJsonRecord("input_json", params.inputJson),
          output_json: serializeOptionalJsonRecord("output_json", params.outputJson),
          error_json: serializeOptionalJsonRecord("error_json", params.errorJson),
          started_at_ms: null,
          updated_at_ms: params.updatedAtMs,
          completed_at_ms: resolveStepCompletedAtMs(params.status, params.updatedAtMs),
        };
        executeSqliteQuerySync(
          database.db,
          getMetaRunStoreKysely(database.db)
            .insertInto("meta_skill_steps")
            .values(row)
            .onConflict((conflict) =>
              conflict.columns(["run_id", "step_id"]).doUpdateSet({
                status: (eb) => eb.ref("excluded.status"),
                input_json: (eb) => eb.ref("excluded.input_json"),
                output_json: (eb) => eb.ref("excluded.output_json"),
                error_json: (eb) => eb.ref("excluded.error_json"),
                updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
                completed_at_ms: (eb) => eb.ref("excluded.completed_at_ms"),
              }),
            ),
        );
        bumpRunUpdatedAt(database.db, params.runId, params.updatedAtMs);
      }, options);
    },

    recordPause(params) {
      runOpenClawStateWriteTransaction((database) => {
        const row: Insertable<MetaSkillPausesTable> = {
          pause_id: params.pauseId,
          run_id: params.runId,
          step_id: params.stepId,
          schema_json: serializeJsonRecord("schema_json", params.schemaJson),
          prefill_json: serializeOptionalJsonRecord("prefill_json", params.prefillJson),
          confirmed_fields_json: serializeOptionalJsonRecord(
            "confirmed_fields_json",
            params.confirmedFieldsJson,
          ),
          session_key: params.sessionKey,
          status: "pending",
          expires_at_ms: params.expiresAtMs,
          created_at_ms: params.createdAtMs,
          resumed_at_ms: null,
        };
        executeSqliteQuerySync(
          database.db,
          getMetaRunStoreKysely(database.db).insertInto("meta_skill_pauses").values(row),
        );
        bumpRunUpdatedAt(database.db, params.runId, params.createdAtMs);
      }, options);
    },

    recordEvidence(params) {
      runOpenClawStateWriteTransaction((database) => {
        const row: Insertable<MetaSkillEvidenceTable> = {
          evidence_id: params.evidenceId,
          run_id: params.runId,
          step_id: params.stepId ?? null,
          proposal_id: params.proposalId ?? null,
          gate_name: params.gateName,
          result: params.result,
          risk_level: params.riskLevel ?? null,
          evidence_json: serializeJsonRecord("evidence_json", params.evidenceJson),
          created_at_ms: params.createdAtMs,
        };
        executeSqliteQuerySync(
          database.db,
          getMetaRunStoreKysely(database.db).insertInto("meta_skill_evidence").values(row),
        );
        bumpRunUpdatedAt(database.db, params.runId, params.createdAtMs);
      }, options);
    },

    readRun(runId) {
      return selectRun(openOpenClawStateDatabase(options).db, runId);
    },

    readPendingPauseForSession(sessionKey, nowMs = Date.now()) {
      return selectPendingPauseForSession(openOpenClawStateDatabase(options).db, sessionKey, nowMs);
    },

    listEvidence(runId) {
      return selectEvidence(openOpenClawStateDatabase(options).db, runId);
    },
  };
}
