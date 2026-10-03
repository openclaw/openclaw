import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { z } from "zod";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { updateRecoverySchema } from "./update-recovery.js";
import { UpdateFailureFactSchema } from "./update-run-schema.js";

type RestartSentinelStats = z.infer<typeof restartSentinelStatsSchema>;
export type RestartSentinelContinuation = z.infer<typeof restartSentinelContinuationSchema>;

export type RestartSentinelPayload = {
  kind: "config-apply" | "config-auto-recovery" | "config-patch" | "update" | "restart";
  status: "ok" | "error" | "skipped";
  ts: number;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
  };
  threadId?: string;
  message?: string | null;
  continuation?: RestartSentinelContinuation | null;
  doctorHint?: string | null;
  stats?: RestartSentinelStats | null;
};

export type RestartSentinelEnvelope = {
  version: 1;
  payload: RestartSentinelPayload;
};

export type RestartSentinel = RestartSentinelEnvelope & {
  /** Optimistic-concurrency revision backed by gateway_restart_sentinel.updated_at_ms. */
  revision: number;
};

export type RestartSentinelRowState =
  | { kind: "missing" }
  | { kind: "invalid"; revision: number }
  | { kind: "valid"; sentinel: RestartSentinel };

const RESTART_SENTINEL_KEY = "current";
const RESTART_SENTINEL_REVISION_FLOOR_KEY = "revision-floor";
const UPDATE_INSTALL_RECEIPT_KEY = "latest-update-install";
type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;
type RestartSentinelRow = Omit<
  Selectable<GatewayRestartSentinelDatabase["gateway_restart_sentinel"]>,
  "sentinel_key" | "payload_json"
>;

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

// Optional properties are absent from the canonical payload, including when an
// input explicitly supplies undefined. Keep nested diagnostic records untouched.
function omitUndefinedFields<T extends object>(value: T): T {
  for (const key in value) {
    if (value[key] === undefined) {
      delete value[key];
    }
  }
  return value;
}

const restartSentinelLogSchema = z
  .object({
    stdoutTail: z.string().nullish(),
    stderrTail: z.string().nullish(),
    exitCode: z.number().int().nullish(),
  })
  .transform(omitUndefinedFields);
const restartSentinelStepSchema = z
  .object({
    name: z.string(),
    command: z.string(),
    failureFacts: UpdateFailureFactSchema.array().max(5).optional().catch(undefined),
    cwd: z.string().nullish(),
    durationMs: z.number().finite().nullish(),
    log: restartSentinelLogSchema.nullish(),
    advisory: z.boolean().optional(),
  })
  .transform(omitUndefinedFields);
const restartSentinelStepsSchema = z.custom<unknown[]>(Array.isArray).transform((steps, ctx) =>
  steps.map((step) => {
    const parsed = restartSentinelStepSchema.safeParse(step);
    if (parsed.success) {
      return parsed.data;
    }
    ctx.addIssue({ code: "custom", message: "Invalid restart sentinel step" });
    return z.NEVER;
  }),
);
const restartSentinelStatsSchema = z
  .object({
    // Unsupported recovery metadata must not suppress the restart notice.
    recovery: updateRecoverySchema.optional().catch(undefined),
    mode: z.string().optional(),
    root: z.string().optional(),
    target: z.string().optional(),
    requiresRestart: z.boolean().optional(),
    handoffId: z.string().optional(),
    runId: z.string().optional(),
    before: z.custom<Record<string, unknown>>(isPlainRecord).nullish(),
    after: z.custom<Record<string, unknown>>(isPlainRecord).nullish(),
    steps: restartSentinelStepsSchema.optional(),
    reason: z.string().nullish(),
    durationMs: z.number().finite().nullish(),
  })
  .transform(omitUndefinedFields);

const restartSentinelContinuationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("systemEvent"), text: z.string() }),
  z.object({ kind: z.literal("agentTurn"), message: z.string() }),
]);
const restartSentinelPayloadSchema = z
  .object({
    kind: z.enum(["config-apply", "config-auto-recovery", "config-patch", "update", "restart"]),
    status: z.enum(["ok", "error", "skipped"]),
    ts: z.number().int(),
    sessionKey: z.string().optional(),
    deliveryContext: z
      .object({
        channel: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
      })
      .transform(omitUndefinedFields)
      .transform((value) => (Object.keys(value).length > 0 ? value : undefined))
      .optional(),
    threadId: z.string().optional(),
    message: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    continuation: restartSentinelContinuationSchema
      .nullish()
      .transform((value) => value ?? undefined),
    doctorHint: z
      .string()
      .nullish()
      .transform((value) => value ?? undefined),
    stats: restartSentinelStatsSchema.nullish().transform((value) => value ?? undefined),
  })
  // SQL NULL is canonical absence for optional top-level columns. Keep legacy
  // nulls and empty routes consistent between writes and typed-column reads.
  .transform(omitUndefinedFields);

function parseRestartSentinelPayload(value: unknown): RestartSentinelPayload | null {
  const parsed = restartSentinelPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseRestartSentinelEnvelope(value: unknown): RestartSentinelEnvelope | null {
  if (!isPlainRecord(value) || value.version !== 1) {
    return null;
  }
  const payload = parseRestartSentinelPayload(value.payload);
  return payload ? { version: 1, payload } : null;
}

function parseRequiredJson(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }
  return safeParseJson(value);
}

function decodeRestartSentinelRow(row: RestartSentinelRow): RestartSentinel | null {
  if (row.version !== 1 || !isSafeInteger(row.updated_at_ms)) {
    return null;
  }
  const continuation = parseRequiredJson(row.continuation_json);
  if (row.continuation_json !== null && continuation === undefined) {
    return null;
  }
  const stats = parseRequiredJson(row.stats_json);
  if (row.stats_json !== null && stats === undefined) {
    return null;
  }
  const payload = parseRestartSentinelPayload({
    kind: row.kind,
    status: row.status,
    ts: row.ts,
    sessionKey: row.session_key ?? undefined,
    threadId: row.thread_id ?? undefined,
    deliveryContext: {
      channel: row.delivery_channel ?? undefined,
      to: row.delivery_to ?? undefined,
      accountId: row.delivery_account_id ?? undefined,
    },
    message: row.message,
    continuation,
    doctorHint: row.doctor_hint,
    stats,
  });
  return payload ? { version: 1, payload, revision: row.updated_at_ms } : null;
}

export function readRestartSentinelRowForKeySync(
  db: DatabaseSync,
  sentinelKey: string,
): RestartSentinelRowState {
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select([
        "version",
        "kind",
        "status",
        "ts",
        "session_key",
        "thread_id",
        "delivery_channel",
        "delivery_to",
        "delivery_account_id",
        "message",
        "continuation_json",
        "doctor_hint",
        "stats_json",
        "updated_at_ms",
      ])
      .where("sentinel_key", "=", sentinelKey),
  );
  if (!row) {
    return { kind: "missing" };
  }
  const sentinel = decodeRestartSentinelRow(row);
  return sentinel ? { kind: "valid", sentinel } : { kind: "invalid", revision: row.updated_at_ms };
}

export function readRestartSentinelRowSync(db: DatabaseSync): RestartSentinelRowState {
  return readRestartSentinelRowForKeySync(db, RESTART_SENTINEL_KEY);
}

export function readUpdateInstallReceiptRowSync(db: DatabaseSync): RestartSentinel | null {
  const current = readRestartSentinelRowForKeySync(db, UPDATE_INSTALL_RECEIPT_KEY);
  return current.kind === "valid" ? current.sentinel : null;
}

function requireValidPayload(payload: RestartSentinelPayload): RestartSentinelPayload {
  const parsed = parseRestartSentinelPayload(payload);
  if (!parsed) {
    throw new TypeError("Invalid restart sentinel payload");
  }
  return parsed;
}

export function nextRevision(currentRevision: number | null): number {
  if (currentRevision !== null && !Number.isSafeInteger(currentRevision)) {
    throw new Error("Restart sentinel revision is outside the safe integer range");
  }
  // Same-millisecond replacements still need distinct revisions, or a stale
  // consumer could delete the newer singleton row after delivering the old one.
  const revision = Math.max(Date.now(), currentRevision === null ? 0 : currentRevision + 1);
  if (!Number.isSafeInteger(revision)) {
    throw new Error("Restart sentinel revision exhausted the safe integer range");
  }
  return revision;
}

function readRestartSentinelRevisionFloorSync(db: DatabaseSync): number | null {
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const row = executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_sentinel")
      .select("updated_at_ms")
      .where("sentinel_key", "=", RESTART_SENTINEL_REVISION_FLOOR_KEY),
  );
  if (!row) {
    return null;
  }
  if (!Number.isSafeInteger(row.updated_at_ms)) {
    throw new Error("Restart sentinel revision floor is outside the safe integer range");
  }
  return row.updated_at_ms;
}

function maxRevision(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.max(left, right);
}

export function buildRestartSentinelRow(
  payload: RestartSentinelPayload,
  revision: number,
  sentinelKey = RESTART_SENTINEL_KEY,
) {
  return {
    sentinel_key: sentinelKey,
    version: 1,
    kind: payload.kind,
    status: payload.status,
    ts: payload.ts,
    session_key: payload.sessionKey ?? null,
    thread_id: payload.threadId ?? null,
    delivery_channel: payload.deliveryContext?.channel ?? null,
    delivery_to: payload.deliveryContext?.to ?? null,
    delivery_account_id: payload.deliveryContext?.accountId ?? null,
    message: payload.message ?? null,
    continuation_json: payload.continuation ? JSON.stringify(payload.continuation) : null,
    doctor_hint: payload.doctorHint ?? null,
    stats_json: payload.stats ? JSON.stringify(payload.stats) : null,
    // Debug shadow only. Reads reconstruct exclusively from typed columns above.
    payload_json: JSON.stringify(payload),
    updated_at_ms: revision,
  };
}

function upsertRestartSentinelRowSync(
  db: DatabaseSync,
  row: ReturnType<typeof buildRestartSentinelRow>,
): void {
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const { sentinel_key: _key, ...values } = row;
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("gateway_restart_sentinel")
      .values(row)
      .onConflict((conflict) => conflict.column("sentinel_key").doUpdateSet(values)),
  );
}

function advanceRestartSentinelRevisionFloorSync(db: DatabaseSync, revision: number): void {
  // `current` is deleted after durable delivery. The reserved row survives that
  // clear so a later same-millisecond write cannot reuse an idempotency revision.
  const payload: RestartSentinelPayload = { kind: "restart", status: "skipped", ts: revision };
  upsertRestartSentinelRowSync(
    db,
    buildRestartSentinelRow(payload, revision, RESTART_SENTINEL_REVISION_FLOOR_KEY),
  );
}

export function writeRestartSentinelRowSync(
  db: DatabaseSync,
  rawPayload: RestartSentinelPayload,
): RestartSentinel {
  const payload = requireValidPayload(rawPayload);
  const revision = nextRevision(readRestartSentinelSnapshotSync(db).revision);
  const row = buildRestartSentinelRow(payload, revision);
  upsertRestartSentinelRowSync(db, row);
  advanceRestartSentinelRevisionFloorSync(db, revision);
  return { version: 1, payload, revision };
}

/** Read inside a transaction; the floor also identifies an absent, consumed notification. */
export function readRestartSentinelSnapshotSync(db: DatabaseSync): {
  state: RestartSentinelRowState;
  revision: number | null;
} {
  const state = readRestartSentinelRowSync(db);
  const currentRevision =
    state.kind === "missing"
      ? null
      : state.kind === "valid"
        ? state.sentinel.revision
        : state.revision;
  return {
    state,
    revision: maxRevision(currentRevision, readRestartSentinelRevisionFloorSync(db)),
  };
}

export function writeUpdateInstallReceiptRowSync(
  db: DatabaseSync,
  rawPayload: RestartSentinelPayload,
): RestartSentinel {
  const payload = requireValidPayload(rawPayload);
  if (payload.kind !== "update" || payload.stats?.mode !== "git") {
    throw new TypeError("Update install receipt requires a git update payload");
  }
  const current = readRestartSentinelRowForKeySync(db, UPDATE_INSTALL_RECEIPT_KEY);
  const currentRevision =
    current.kind === "missing"
      ? null
      : current.kind === "valid"
        ? current.sentinel.revision
        : current.revision;
  const revision = nextRevision(currentRevision);
  upsertRestartSentinelRowSync(
    db,
    buildRestartSentinelRow(payload, revision, UPDATE_INSTALL_RECEIPT_KEY),
  );
  return { version: 1, payload, revision };
}

/** Compare inside the caller's transaction; null requires an absent current row. */
export function writeRestartSentinelRowIfRevisionSync(
  db: DatabaseSync,
  rawPayload: RestartSentinelPayload,
  expectedRevision: number | null,
): RestartSentinel | null {
  const { state: current, revision: previousRevision } = readRestartSentinelSnapshotSync(db);
  if (
    expectedRevision === null
      ? current.kind !== "missing"
      : current.kind !== "valid" || current.sentinel.revision !== expectedRevision
  ) {
    return null;
  }
  const payload = requireValidPayload(rawPayload);
  const revision = nextRevision(previousRevision);
  const row = buildRestartSentinelRow(payload, revision);
  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const result = executeSqliteQuerySync(
    db,
    expectedRevision === null
      ? stateDb
          .insertInto("gateway_restart_sentinel")
          .values(row)
          .onConflict((conflict) => conflict.column("sentinel_key").doNothing())
      : stateDb
          .updateTable("gateway_restart_sentinel")
          .set(row)
          .where("sentinel_key", "=", RESTART_SENTINEL_KEY)
          .where("updated_at_ms", "=", expectedRevision),
  );
  if (result.numAffectedRows !== 1n) {
    return null;
  }
  advanceRestartSentinelRevisionFloorSync(db, revision);
  return { version: 1, payload, revision };
}

export function deleteRestartSentinelRowSync(db: DatabaseSync, expectedRevision: number): boolean {
  const current = readRestartSentinelRowSync(db);
  if (current.kind === "missing") {
    return false;
  }
  const currentRevision = current.kind === "valid" ? current.sentinel.revision : current.revision;
  if (currentRevision !== expectedRevision) {
    return false;
  }
  if (!Number.isSafeInteger(currentRevision)) {
    throw new Error("Restart sentinel revision is outside the safe integer range");
  }
  advanceRestartSentinelRevisionFloorSync(
    db,
    maxRevision(currentRevision, readRestartSentinelRevisionFloorSync(db)) ?? currentRevision,
  );

  const stateDb = getNodeSqliteKysely<GatewayRestartSentinelDatabase>(db);
  const query = stateDb
    .deleteFrom("gateway_restart_sentinel")
    .where("sentinel_key", "=", RESTART_SENTINEL_KEY)
    .where("updated_at_ms", "=", expectedRevision);
  if (executeSqliteQuerySync(db, query).numAffectedRows !== 1n) {
    // The outer write transaction owns both rows; fail closed so its rollback
    // cannot leave a floor for a current row this call did not consume.
    throw new Error("Restart sentinel changed during guarded delete");
  }
  return true;
}
