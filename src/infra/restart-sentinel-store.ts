import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { UpdateFailureFact } from "./update-failure-facts.js";
import { updateRecoverySchema, type UpdateRecovery } from "./update-recovery.js";
import { UpdateFailureFactSchema } from "./update-run-schema.js";

type RestartSentinelLog = {
  stdoutTail?: string | null;
  stderrTail?: string | null;
  exitCode?: number | null;
};

type RestartSentinelStep = {
  name: string;
  command: string;
  cwd?: string | null;
  durationMs?: number | null;
  log?: RestartSentinelLog | null;
  advisory?: boolean;
  failureFacts?: UpdateFailureFact[];
};

type RestartSentinelStats = {
  runId?: string;
  recovery?: UpdateRecovery;
  mode?: string;
  root?: string;
  target?: string;
  requiresRestart?: boolean;
  handoffId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  steps?: RestartSentinelStep[];
  reason?: string | null;
  durationMs?: number | null;
};

export type RestartSentinelContinuation =
  | {
      kind: "systemEvent";
      text: string;
    }
  | {
      kind: "agentTurn";
      message: string;
    };

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
const RESTART_SENTINEL_KINDS = new Set<RestartSentinelPayload["kind"]>([
  "config-apply",
  "config-auto-recovery",
  "config-patch",
  "update",
  "restart",
]);
const RESTART_SENTINEL_STATUSES = new Set<RestartSentinelPayload["status"]>([
  "ok",
  "error",
  "skipped",
]);

type GatewayRestartSentinelDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_sentinel">;
type RestartSentinelRow = Omit<
  Selectable<GatewayRestartSentinelDatabase["gateway_restart_sentinel"]>,
  "sentinel_key" | "payload_json"
>;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function parseOptionalNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined | false {
  const value = record[key];
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }
  return false;
}

function parseRestartSentinelLog(value: unknown): RestartSentinelLog | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const stdoutTail = parseOptionalNullableString(value, "stdoutTail");
  const stderrTail = parseOptionalNullableString(value, "stderrTail");
  const exitCode = value.exitCode;
  if (
    stdoutTail === false ||
    stderrTail === false ||
    (exitCode !== undefined && exitCode !== null && !isSafeInteger(exitCode))
  ) {
    return null;
  }
  return {
    ...(stdoutTail !== undefined ? { stdoutTail } : {}),
    ...(stderrTail !== undefined ? { stderrTail } : {}),
    ...(exitCode !== undefined ? { exitCode: exitCode as number | null } : {}),
  };
}

function parseRestartSentinelStep(value: unknown): RestartSentinelStep | null {
  if (
    !isPlainRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.command !== "string"
  ) {
    return null;
  }
  const cwd = parseOptionalNullableString(value, "cwd");
  const durationMs = value.durationMs;
  const log = value.log;
  const advisory = value.advisory;
  if (
    cwd === false ||
    (durationMs !== undefined && durationMs !== null && !isFiniteNumber(durationMs)) ||
    (log !== undefined && log !== null && !parseRestartSentinelLog(log)) ||
    (advisory !== undefined && typeof advisory !== "boolean")
  ) {
    return null;
  }
  const { name, command } = value;
  const facts = UpdateFailureFactSchema.array().max(5).safeParse(value.failureFacts);
  return {
    name,
    command,
    ...(facts.success ? { failureFacts: facts.data } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(durationMs !== undefined ? { durationMs: durationMs as number | null } : {}),
    ...(log !== undefined ? { log: log === null ? null : parseRestartSentinelLog(log) } : {}),
    ...(advisory !== undefined ? { advisory } : {}),
  };
}

function parseRestartSentinelStats(value: unknown): RestartSentinelStats | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  const mode = parseOptionalNullableString(value, "mode");
  const root = parseOptionalNullableString(value, "root");
  const target = parseOptionalNullableString(value, "target");
  const handoffId = parseOptionalNullableString(value, "handoffId");
  const runId = parseOptionalNullableString(value, "runId");
  const reason = parseOptionalNullableString(value, "reason");
  const before = value.before;
  const after = value.after;
  const steps = value.steps;
  const durationMs = value.durationMs;
  const recovery =
    value.recovery === undefined ? undefined : updateRecoverySchema.safeParse(value.recovery);
  if (
    mode === false ||
    mode === null ||
    root === false ||
    root === null ||
    target === false ||
    target === null ||
    handoffId === false ||
    handoffId === null ||
    runId === false ||
    runId === null ||
    reason === false ||
    (value.requiresRestart !== undefined && typeof value.requiresRestart !== "boolean") ||
    (before !== undefined && before !== null && !isPlainRecord(before)) ||
    (after !== undefined && after !== null && !isPlainRecord(after)) ||
    (steps !== undefined &&
      (!Array.isArray(steps) || steps.some((step) => !parseRestartSentinelStep(step)))) ||
    (durationMs !== undefined && durationMs !== null && !isFiniteNumber(durationMs))
  ) {
    return null;
  }
  // Recovery is diagnostic here; unsupported metadata must not suppress the restart notice.
  return {
    ...(recovery?.success ? { recovery: recovery.data } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(root !== undefined ? { root } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(value.requiresRestart !== undefined
      ? { requiresRestart: value.requiresRestart as boolean }
      : {}),
    ...(handoffId !== undefined ? { handoffId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(before !== undefined ? { before: before as Record<string, unknown> | null } : {}),
    ...(after !== undefined ? { after: after as Record<string, unknown> | null } : {}),
    ...(steps !== undefined ? { steps: steps.map((step) => parseRestartSentinelStep(step)!) } : {}),
    ...(reason !== undefined ? { reason } : {}),
    ...(durationMs !== undefined ? { durationMs: durationMs as number | null } : {}),
  };
}

function parseRestartSentinelContinuation(value: unknown): RestartSentinelContinuation | null {
  if (!isPlainRecord(value)) {
    return null;
  }
  if (value.kind === "systemEvent" && typeof value.text === "string") {
    return { kind: "systemEvent", text: value.text };
  }
  if (value.kind === "agentTurn" && typeof value.message === "string") {
    return { kind: "agentTurn", message: value.message };
  }
  return null;
}

function parseRestartSentinelPayload(value: unknown): RestartSentinelPayload | null {
  if (
    !isPlainRecord(value) ||
    !RESTART_SENTINEL_KINDS.has(value.kind as RestartSentinelPayload["kind"]) ||
    !RESTART_SENTINEL_STATUSES.has(value.status as RestartSentinelPayload["status"]) ||
    !isSafeInteger(value.ts)
  ) {
    return null;
  }
  const sessionKey = parseOptionalNullableString(value, "sessionKey");
  const threadId = parseOptionalNullableString(value, "threadId");
  const message = parseOptionalNullableString(value, "message");
  const doctorHint = parseOptionalNullableString(value, "doctorHint");
  if (
    sessionKey === false ||
    sessionKey === null ||
    threadId === false ||
    threadId === null ||
    message === false ||
    doctorHint === false
  ) {
    return null;
  }

  let deliveryContext: RestartSentinelPayload["deliveryContext"];
  if (value.deliveryContext !== undefined) {
    if (!isPlainRecord(value.deliveryContext)) {
      return null;
    }
    const channel = parseOptionalNullableString(value.deliveryContext, "channel");
    const to = parseOptionalNullableString(value.deliveryContext, "to");
    const accountId = parseOptionalNullableString(value.deliveryContext, "accountId");
    if (
      channel === false ||
      channel === null ||
      to === false ||
      to === null ||
      accountId === false ||
      accountId === null
    ) {
      return null;
    }
    deliveryContext = {
      ...(channel !== undefined ? { channel } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(accountId !== undefined ? { accountId } : {}),
    };
  }

  let continuation: RestartSentinelContinuation | null | undefined;
  if (value.continuation !== undefined) {
    continuation =
      value.continuation === null ? null : parseRestartSentinelContinuation(value.continuation);
    if (continuation === null && value.continuation !== null) {
      return null;
    }
  }

  let stats: RestartSentinelStats | null | undefined;
  if (value.stats !== undefined) {
    stats = value.stats === null ? null : parseRestartSentinelStats(value.stats);
    if (stats === null && value.stats !== null) {
      return null;
    }
  }

  // SQL NULL is canonical absence for optional top-level columns. Normalize
  // legacy nulls and empty routes so writes and typed-column reads agree.
  return {
    kind: value.kind as RestartSentinelPayload["kind"],
    status: value.status as RestartSentinelPayload["status"],
    ts: value.ts,
    ...(sessionKey !== undefined ? { sessionKey } : {}),
    ...(deliveryContext !== undefined && Object.keys(deliveryContext).length > 0
      ? { deliveryContext }
      : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(message !== undefined && message !== null ? { message } : {}),
    ...(continuation !== undefined && continuation !== null ? { continuation } : {}),
    ...(doctorHint !== undefined && doctorHint !== null ? { doctorHint } : {}),
    ...(stats !== undefined && stats !== null ? { stats } : {}),
  };
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

export function deleteRestartSentinelRowSync(db: DatabaseSync, expectedRevision?: number): boolean {
  const current = readRestartSentinelRowSync(db);
  if (current.kind === "missing") {
    return false;
  }
  const currentRevision = current.kind === "valid" ? current.sentinel.revision : current.revision;
  if (expectedRevision !== undefined && currentRevision !== expectedRevision) {
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
  let query = stateDb
    .deleteFrom("gateway_restart_sentinel")
    .where("sentinel_key", "=", RESTART_SENTINEL_KEY);
  if (expectedRevision !== undefined) {
    query = query.where("updated_at_ms", "=", expectedRevision);
  }
  if (executeSqliteQuerySync(db, query).numAffectedRows !== 1n) {
    // The outer write transaction owns both rows; fail closed so its rollback
    // cannot leave a floor for a current row this call did not consume.
    throw new Error("Restart sentinel changed during guarded delete");
  }
  return true;
}
