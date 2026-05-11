import { randomBytes } from "node:crypto";
import type { Insertable, Selectable } from "kysely";
import type { OpenClawConfig } from "../config/config.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { sqliteNullableNumber, sqliteNullableText } from "../infra/sqlite-row-values.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS,
  DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  resolveCommitmentsConfig,
} from "./config.js";
import type {
  CommitmentCandidate,
  CommitmentExtractionItem,
  CommitmentRecord,
  CommitmentScope,
  CommitmentStatus,
  CommitmentStoreSnapshot,
} from "./types.js";

const STORE_VERSION = 1 as const;
const ROLLING_DAY_MS = 24 * 60 * 60 * 1000;

type LoadedCommitmentStore = {
  store: CommitmentStoreSnapshot;
  hadLegacySourceText: boolean;
};

export function resolveCommitmentDatabasePath(): string {
  return resolveOpenClawStateSqlitePath();
}

function emptyStore(): CommitmentStoreSnapshot {
  return { version: STORE_VERSION, commitments: [] };
}

function sqliteOptionsForEnv(env: NodeJS.ProcessEnv): OpenClawStateDatabaseOptions {
  return { env };
}

type CommitmentsDatabase = Pick<OpenClawStateKyselyDatabase, "commitments">;
type CommitmentRow = Selectable<CommitmentsDatabase["commitments"]>;
type CommitmentRowInsert = Insertable<CommitmentsDatabase["commitments"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceCommitment(raw: unknown): CommitmentRecord | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const dueWindow = isRecord(raw.dueWindow) ? raw.dueWindow : undefined;
  if (!dueWindow) {
    return undefined;
  }
  const requiredStrings = [
    raw.id,
    raw.agentId,
    raw.sessionKey,
    raw.channel,
    raw.kind,
    raw.sensitivity,
    raw.source,
    raw.status,
    raw.reason,
    raw.suggestedText,
    raw.dedupeKey,
  ];
  if (requiredStrings.some((value) => typeof value !== "string" || !value.trim())) {
    return undefined;
  }
  if (
    typeof raw.confidence !== "number" ||
    typeof raw.createdAtMs !== "number" ||
    typeof raw.updatedAtMs !== "number" ||
    typeof raw.attempts !== "number" ||
    typeof dueWindow.earliestMs !== "number" ||
    typeof dueWindow.latestMs !== "number" ||
    typeof dueWindow.timezone !== "string"
  ) {
    return undefined;
  }
  const commitment = { ...raw } as CommitmentRecord;
  return stripLegacySourceText(commitment);
}

function hasLegacySourceText(raw: unknown): boolean {
  return isRecord(raw) && ("sourceUserText" in raw || "sourceAssistantText" in raw);
}

function stripLegacySourceText(commitment: CommitmentRecord): CommitmentRecord {
  const stripped = { ...commitment };
  // The extraction prompt can read the source turn, but delivery state should
  // not persist or replay raw conversation text into later heartbeat turns.
  delete stripped.sourceUserText;
  delete stripped.sourceAssistantText;
  return stripped;
}

function sanitizeStoreForWrite(store: CommitmentStoreSnapshot): CommitmentStoreSnapshot {
  return {
    ...store,
    commitments: store.commitments.map(stripLegacySourceText),
  };
}

function coerceCommitmentStore(parsed: unknown): LoadedCommitmentStore {
  if (!isRecord(parsed) || parsed.version !== STORE_VERSION || !Array.isArray(parsed.commitments)) {
    return { store: emptyStore(), hadLegacySourceText: false };
  }
  let hadLegacySourceText = false;
  return {
    store: {
      version: STORE_VERSION,
      commitments: parsed.commitments.flatMap((entry) => {
        hadLegacySourceText ||= hasLegacySourceText(entry);
        const coerced = coerceCommitment(entry);
        return coerced ? [coerced] : [];
      }),
    },
    hadLegacySourceText,
  };
}

function loadCommitmentStoreFromSqlite(
  env: NodeJS.ProcessEnv = process.env,
): LoadedCommitmentStore {
  const database = openOpenClawStateDatabase(sqliteOptionsForEnv(env));
  const db = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db.selectFrom("commitments").selectAll().orderBy("due_earliest_ms", "asc").orderBy("id", "asc"),
  ).rows;
  return {
    store: {
      version: STORE_VERSION,
      commitments: rows.flatMap((row) => {
        const commitment = commitmentFromRow(row);
        return commitment ? [commitment] : [];
      }),
    },
    hadLegacySourceText: false,
  };
}

function optionalText(value: string | null): string | undefined {
  return value ?? undefined;
}

function optionalNumber(value: number | null): number | undefined {
  return value ?? undefined;
}

function commitmentFromRow(row: CommitmentRow): CommitmentRecord | undefined {
  const accountId = optionalText(row.account_id);
  const recipientId = optionalText(row.recipient_id);
  const threadId = optionalText(row.thread_id);
  const senderId = optionalText(row.sender_id);
  const sourceMessageId = optionalText(row.source_message_id);
  const sourceRunId = optionalText(row.source_run_id);
  const lastAttemptAtMs = optionalNumber(row.last_attempt_at_ms);
  const sentAtMs = optionalNumber(row.sent_at_ms);
  const dismissedAtMs = optionalNumber(row.dismissed_at_ms);
  const snoozedUntilMs = optionalNumber(row.snoozed_until_ms);
  const expiredAtMs = optionalNumber(row.expired_at_ms);
  return coerceCommitment({
    id: row.id,
    agentId: row.agent_id,
    sessionKey: row.session_key,
    channel: row.channel,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(recipientId !== undefined ? { to: recipientId } : {}),
    ...(threadId !== undefined ? { threadId } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
    kind: row.kind,
    sensitivity: row.sensitivity,
    source: row.source,
    status: row.status,
    reason: row.reason,
    suggestedText: row.suggested_text,
    dedupeKey: row.dedupe_key,
    confidence: row.confidence,
    dueWindow: {
      earliestMs: row.due_earliest_ms,
      latestMs: row.due_latest_ms,
      timezone: row.due_timezone,
    },
    ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    ...(sourceRunId !== undefined ? { sourceRunId } : {}),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    attempts: row.attempts,
    ...(lastAttemptAtMs !== undefined ? { lastAttemptAtMs } : {}),
    ...(sentAtMs !== undefined ? { sentAtMs } : {}),
    ...(dismissedAtMs !== undefined ? { dismissedAtMs } : {}),
    ...(snoozedUntilMs !== undefined ? { snoozedUntilMs } : {}),
    ...(expiredAtMs !== undefined ? { expiredAtMs } : {}),
  });
}

function commitmentToRow(commitment: CommitmentRecord): CommitmentRowInsert {
  return {
    id: commitment.id,
    agent_id: commitment.agentId,
    session_key: commitment.sessionKey,
    channel: commitment.channel,
    account_id: sqliteNullableText(commitment.accountId),
    recipient_id: sqliteNullableText(commitment.to),
    thread_id: sqliteNullableText(commitment.threadId),
    sender_id: sqliteNullableText(commitment.senderId),
    kind: commitment.kind,
    sensitivity: commitment.sensitivity,
    source: commitment.source,
    status: commitment.status,
    reason: commitment.reason,
    suggested_text: commitment.suggestedText,
    dedupe_key: commitment.dedupeKey,
    confidence: commitment.confidence,
    due_earliest_ms: commitment.dueWindow.earliestMs,
    due_latest_ms: commitment.dueWindow.latestMs,
    due_timezone: commitment.dueWindow.timezone,
    source_message_id: sqliteNullableText(commitment.sourceMessageId),
    source_run_id: sqliteNullableText(commitment.sourceRunId),
    created_at_ms: commitment.createdAtMs,
    updated_at_ms: commitment.updatedAtMs,
    attempts: commitment.attempts,
    last_attempt_at_ms: sqliteNullableNumber(commitment.lastAttemptAtMs),
    sent_at_ms: sqliteNullableNumber(commitment.sentAtMs),
    dismissed_at_ms: sqliteNullableNumber(commitment.dismissedAtMs),
    snoozed_until_ms: sqliteNullableNumber(commitment.snoozedUntilMs),
    expired_at_ms: sqliteNullableNumber(commitment.expiredAtMs),
    record_json: JSON.stringify(commitment),
  };
}

function loadCommitmentStoreInternal(): LoadedCommitmentStore {
  return loadCommitmentStoreFromSqlite();
}

export async function loadCommitmentStore(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<CommitmentStoreSnapshot> {
  return loadCommitmentStoreFromSqlite(options.env ?? process.env).store;
}

function replaceCommitmentRows(
  store: CommitmentStoreSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const sanitized = sanitizeStoreForWrite(store);
  runOpenClawStateWriteTransaction((database) => {
    const db = getNodeSqliteKysely<CommitmentsDatabase>(database.db);
    const rows = sanitized.commitments.map((commitment) => commitmentToRow(commitment));
    if (rows.length === 0) {
      executeSqliteQuerySync(database.db, db.deleteFrom("commitments"));
      return;
    }
    const ids = rows.map((row) => row.id);
    executeSqliteQuerySync(database.db, db.deleteFrom("commitments").where("id", "not in", ids));
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("commitments")
        .values(rows)
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            agent_id: (eb) => eb.ref("excluded.agent_id"),
            session_key: (eb) => eb.ref("excluded.session_key"),
            channel: (eb) => eb.ref("excluded.channel"),
            account_id: (eb) => eb.ref("excluded.account_id"),
            recipient_id: (eb) => eb.ref("excluded.recipient_id"),
            thread_id: (eb) => eb.ref("excluded.thread_id"),
            sender_id: (eb) => eb.ref("excluded.sender_id"),
            kind: (eb) => eb.ref("excluded.kind"),
            sensitivity: (eb) => eb.ref("excluded.sensitivity"),
            source: (eb) => eb.ref("excluded.source"),
            status: (eb) => eb.ref("excluded.status"),
            reason: (eb) => eb.ref("excluded.reason"),
            suggested_text: (eb) => eb.ref("excluded.suggested_text"),
            dedupe_key: (eb) => eb.ref("excluded.dedupe_key"),
            confidence: (eb) => eb.ref("excluded.confidence"),
            due_earliest_ms: (eb) => eb.ref("excluded.due_earliest_ms"),
            due_latest_ms: (eb) => eb.ref("excluded.due_latest_ms"),
            due_timezone: (eb) => eb.ref("excluded.due_timezone"),
            source_message_id: (eb) => eb.ref("excluded.source_message_id"),
            source_run_id: (eb) => eb.ref("excluded.source_run_id"),
            created_at_ms: (eb) => eb.ref("excluded.created_at_ms"),
            updated_at_ms: (eb) => eb.ref("excluded.updated_at_ms"),
            attempts: (eb) => eb.ref("excluded.attempts"),
            last_attempt_at_ms: (eb) => eb.ref("excluded.last_attempt_at_ms"),
            sent_at_ms: (eb) => eb.ref("excluded.sent_at_ms"),
            dismissed_at_ms: (eb) => eb.ref("excluded.dismissed_at_ms"),
            snoozed_until_ms: (eb) => eb.ref("excluded.snoozed_until_ms"),
            expired_at_ms: (eb) => eb.ref("excluded.expired_at_ms"),
            record_json: (eb) => eb.ref("excluded.record_json"),
          }),
        ),
    );
  }, sqliteOptionsForEnv(env));
}

export async function saveCommitmentStore(
  store: CommitmentStoreSnapshot,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  replaceCommitmentRows(store, options.env ?? process.env);
}

function generateCommitmentId(nowMs: number): string {
  return `cm_${nowMs.toString(36)}_${randomBytes(5).toString("hex")}`;
}

function scopeValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function buildCommitmentScopeKey(scope: CommitmentScope): string {
  return [
    scopeValue(scope.agentId),
    scopeValue(scope.sessionKey),
    scopeValue(scope.channel),
    scopeValue(scope.accountId),
    scopeValue(scope.to),
    scopeValue(scope.threadId),
    scopeValue(scope.senderId),
  ].join("\u001f");
}

function isActiveStatus(status: CommitmentStatus): boolean {
  return status === "pending" || status === "snoozed";
}

function candidateToRecord(params: {
  item: CommitmentExtractionItem;
  candidate: CommitmentCandidate;
  nowMs: number;
  earliestMs: number;
  latestMs: number;
  timezone: string;
}): CommitmentRecord {
  return {
    id: generateCommitmentId(params.nowMs),
    agentId: params.item.agentId,
    sessionKey: params.item.sessionKey,
    channel: params.item.channel,
    ...(params.item.accountId ? { accountId: params.item.accountId } : {}),
    ...(params.item.to ? { to: params.item.to } : {}),
    ...(params.item.threadId ? { threadId: params.item.threadId } : {}),
    ...(params.item.senderId ? { senderId: params.item.senderId } : {}),
    kind: params.candidate.kind,
    sensitivity: params.candidate.sensitivity,
    source: params.candidate.source,
    status: "pending",
    reason: params.candidate.reason.trim(),
    suggestedText: params.candidate.suggestedText.trim(),
    dedupeKey: params.candidate.dedupeKey.trim(),
    confidence: params.candidate.confidence,
    dueWindow: {
      earliestMs: params.earliestMs,
      latestMs: params.latestMs,
      timezone: params.timezone,
    },
    ...(params.item.sourceMessageId ? { sourceMessageId: params.item.sourceMessageId } : {}),
    ...(params.item.sourceRunId ? { sourceRunId: params.item.sourceRunId } : {}),
    createdAtMs: params.nowMs,
    updatedAtMs: params.nowMs,
    attempts: 0,
  };
}

function expireAfterMs(): number {
  return DEFAULT_COMMITMENT_EXPIRE_AFTER_HOURS * 60 * 60 * 1000;
}

function expireStaleCommitmentsInStore(store: CommitmentStoreSnapshot, nowMs: number): boolean {
  const staleAfterMs = expireAfterMs();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (
      !isActiveStatus(commitment.status) ||
      commitment.dueWindow.latestMs + staleAfterMs >= nowMs
    ) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      status: "expired",
      expiredAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  });
  return changed;
}

async function loadCommitmentStoreWithExpiredMarked(
  nowMs: number,
): Promise<CommitmentStoreSnapshot> {
  const { store, hadLegacySourceText } = loadCommitmentStoreInternal();
  if (expireStaleCommitmentsInStore(store, nowMs) || hadLegacySourceText) {
    await saveCommitmentStore(store);
  }
  return store;
}

export async function listPendingCommitmentsForScope(params: {
  cfg?: OpenClawConfig;
  scope: CommitmentScope;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const scopeKey = buildCommitmentScopeKey(params.scope);
  const limit = params.limit ?? 20;
  return store.commitments
    .filter(
      (commitment) =>
        buildCommitmentScopeKey(commitment) === scopeKey &&
        isActiveStatus(commitment.status) &&
        (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    )
    .slice(0, limit);
}

export async function upsertInferredCommitments(params: {
  cfg?: OpenClawConfig;
  item: CommitmentExtractionItem;
  candidates: Array<{
    candidate: CommitmentCandidate;
    earliestMs: number;
    latestMs: number;
    timezone: string;
  }>;
  nowMs?: number;
}): Promise<CommitmentRecord[]> {
  if (params.candidates.length === 0) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const created: CommitmentRecord[] = [];
  const scopeKey = buildCommitmentScopeKey(params.item);

  for (const entry of params.candidates) {
    const dedupeKey = entry.candidate.dedupeKey.trim();
    const existingIndex = store.commitments.findIndex(
      (commitment) =>
        buildCommitmentScopeKey(commitment) === scopeKey &&
        commitment.dedupeKey === dedupeKey &&
        isActiveStatus(commitment.status),
    );
    if (existingIndex >= 0) {
      const existing = store.commitments[existingIndex];
      store.commitments[existingIndex] = {
        ...existing,
        reason: entry.candidate.reason.trim() || existing.reason,
        suggestedText: entry.candidate.suggestedText.trim() || existing.suggestedText,
        confidence: Math.max(existing.confidence, entry.candidate.confidence),
        dueWindow: {
          earliestMs: Math.min(existing.dueWindow.earliestMs, entry.earliestMs),
          latestMs: Math.max(existing.dueWindow.latestMs, entry.latestMs),
          timezone: entry.timezone,
        },
        updatedAtMs: nowMs,
      };
      continue;
    }
    const record = candidateToRecord({
      item: params.item,
      candidate: entry.candidate,
      nowMs,
      earliestMs: entry.earliestMs,
      latestMs: entry.latestMs,
      timezone: entry.timezone,
    });
    store.commitments.push(record);
    created.push(record);
  }
  await saveCommitmentStore(store);
  return created;
}

function countSentCommitmentsForSession(params: {
  store: CommitmentStoreSnapshot;
  agentId: string;
  sessionKey: string;
  nowMs: number;
}): number {
  const sinceMs = params.nowMs - ROLLING_DAY_MS;
  return params.store.commitments.filter(
    (commitment) =>
      commitment.agentId === params.agentId &&
      commitment.sessionKey === params.sessionKey &&
      commitment.status === "sent" &&
      (commitment.sentAtMs ?? 0) >= sinceMs,
  ).length;
}

export async function listDueCommitmentsForSession(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  nowMs?: number;
  limit?: number;
}): Promise<CommitmentRecord[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const remainingToday =
    resolved.maxPerDay -
    countSentCommitmentsForSession({
      store,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      nowMs,
    });
  if (remainingToday <= 0) {
    return [];
  }
  const limit = Math.min(
    params.limit ?? DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
    remainingToday,
    DEFAULT_COMMITMENT_MAX_PER_HEARTBEAT,
  );
  const staleAfterMs = expireAfterMs();
  return store.commitments
    .filter(
      (commitment) =>
        commitment.agentId === params.agentId &&
        commitment.sessionKey === params.sessionKey &&
        isActiveStatus(commitment.status) &&
        commitment.dueWindow.earliestMs <= nowMs &&
        commitment.dueWindow.latestMs + staleAfterMs >= nowMs &&
        (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    )
    .slice(0, limit);
}

export async function listDueCommitmentSessionKeys(params: {
  cfg?: OpenClawConfig;
  agentId: string;
  nowMs?: number;
  limit?: number;
}): Promise<string[]> {
  const resolved = resolveCommitmentsConfig(params.cfg);
  if (!resolved.enabled) {
    return [];
  }
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStoreWithExpiredMarked(nowMs);
  const staleAfterMs = expireAfterMs();
  const keys = new Set<string>();
  for (const commitment of store.commitments) {
    if (
      commitment.agentId === params.agentId &&
      isActiveStatus(commitment.status) &&
      commitment.dueWindow.earliestMs <= nowMs &&
      commitment.dueWindow.latestMs + staleAfterMs >= nowMs &&
      (commitment.status !== "snoozed" || (commitment.snoozedUntilMs ?? 0) <= nowMs) &&
      countSentCommitmentsForSession({
        store,
        agentId: params.agentId,
        sessionKey: commitment.sessionKey,
        nowMs,
      }) < resolved.maxPerDay
    ) {
      keys.add(commitment.sessionKey);
    }
    if (params.limit && keys.size >= params.limit) {
      break;
    }
  }
  return [...keys].toSorted();
}

export async function markCommitmentsAttempted(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  nowMs?: number;
}): Promise<void> {
  if (params.ids.length === 0) {
    return;
  }
  const idSet = new Set(params.ids);
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStore();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (!idSet.has(commitment.id)) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      attempts: commitment.attempts + 1,
      lastAttemptAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  });
  if (changed) {
    await saveCommitmentStore(store);
  }
}

export async function markCommitmentsStatus(params: {
  cfg?: OpenClawConfig;
  ids: string[];
  status: Extract<CommitmentStatus, "sent" | "dismissed" | "expired">;
  nowMs?: number;
}): Promise<void> {
  if (params.ids.length === 0) {
    return;
  }
  const idSet = new Set(params.ids);
  const nowMs = params.nowMs ?? Date.now();
  const store = await loadCommitmentStore();
  let changed = false;
  store.commitments = store.commitments.map((commitment) => {
    if (!idSet.has(commitment.id) || !isActiveStatus(commitment.status)) {
      return commitment;
    }
    changed = true;
    return {
      ...commitment,
      status: params.status,
      updatedAtMs: nowMs,
      ...(params.status === "sent" ? { sentAtMs: nowMs } : {}),
      ...(params.status === "dismissed" ? { dismissedAtMs: nowMs } : {}),
      ...(params.status === "expired" ? { expiredAtMs: nowMs } : {}),
    };
  });
  if (changed) {
    await saveCommitmentStore(store);
  }
}

export async function listCommitments(params?: {
  cfg?: OpenClawConfig;
  status?: CommitmentStatus;
  agentId?: string;
}): Promise<CommitmentRecord[]> {
  const store = await loadCommitmentStoreWithExpiredMarked(Date.now());
  return store.commitments
    .filter(
      (commitment) =>
        (!params?.status || commitment.status === params.status) &&
        (!params?.agentId || commitment.agentId === params.agentId),
    )
    .toSorted(
      (a, b) => a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAtMs - b.createdAtMs,
    );
}
