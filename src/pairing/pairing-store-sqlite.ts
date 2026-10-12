// Internal SQLite persistence for channel pairing requests and allow entries.
import type { DatabaseSync } from "node:sqlite";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  dedupePreserveOrder,
  resolveAllowFromAccountId,
  resolvePairingRequestAccountId,
  safeChannelKey,
} from "./pairing-store-keys.js";
import type { PairingChannel, PairingRequestRecord } from "./pairing-store.types.js";

type PairingRequest = PairingRequestRecord;

type PairingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_pairing_allow_entries" | "channel_pairing_requests"
>;
type PairingRequestRow = Selectable<PairingDatabase["channel_pairing_requests"]>;
type PairingAllowRow = Selectable<PairingDatabase["channel_pairing_allow_entries"]>;

type ChannelPairingState = {
  version: 1;
  requests: PairingRequest[];
  allowFrom?: Record<string, string[]>;
};

function normalizePersistedPairingMeta(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeOptionalString(entry);
    if (normalized) {
      out[key] = normalized;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizePersistedPairingRequest(value: unknown): PairingRequest | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = normalizeOptionalString(value.id);
  const code = normalizeOptionalString(value.code);
  const createdAt = normalizeOptionalString(value.createdAt);
  const lastSeenAt = normalizeOptionalString(value.lastSeenAt) ?? createdAt;
  if (
    !id ||
    !code ||
    !createdAt ||
    !lastSeenAt ||
    parseDateStringTimestampMs(createdAt) === undefined ||
    parseDateStringTimestampMs(lastSeenAt) === undefined
  ) {
    return undefined;
  }
  const meta = normalizePersistedPairingMeta(value.meta);
  return { id, code, createdAt, lastSeenAt, ...(meta ? { meta } : {}) };
}

function readChannelAllowRows(database: DatabaseSync, channel: PairingChannel) {
  const db = getNodeSqliteKysely<PairingDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("channel_pairing_allow_entries")
      .selectAll()
      .where("channel_key", "=", safeChannelKey(channel))
      .orderBy("account_id", "asc")
      .orderBy("sort_order", "asc")
      .orderBy("entry", "asc"),
  ).rows;
}

export function readChannelAllowEntries(database: DatabaseSync, channel: PairingChannel) {
  const rows = readChannelAllowRows(database, channel);
  const allowFrom: Record<string, string[]> = {};
  for (const row of rows) {
    const accountId = resolveAllowFromAccountId(row.account_id);
    (allowFrom[accountId] ??= []).push(row.entry);
  }
  return allowFrom;
}

export const pairingReadOperations = {
  "pairing.allowFrom": (input: { channel: string; accountId: string }, db) => ({
    type: "pairing.allowFrom" as const,
    // Match the native reader's refusal of inherited, non-array account keys.
    entries: (readChannelAllowEntries(db, input.channel)[input.accountId] ?? []).slice(),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;

function normalizePairingRequestRows(rows: readonly PairingRequestRow[]): PairingRequest[] {
  return rows.flatMap((row) => {
    let meta: Record<string, string> | undefined;
    if (row.meta_json) {
      try {
        meta = normalizePersistedPairingMeta(JSON.parse(row.meta_json));
      } catch {
        meta = undefined;
      }
    }
    // The indexed column owns request scope. Duplicated metadata may be absent or stale and
    // must never move a request or approval across accounts during a state rewrite.
    meta = { ...meta, accountId: resolveAllowFromAccountId(row.account_id) };
    const request = normalizePersistedPairingRequest({
      id: row.request_id,
      code: row.code,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      meta,
    });
    return request ? [request] : [];
  });
}

export function readChannelPairingRequests(
  database: DatabaseSync,
  channel: PairingChannel,
): PairingRequestRecord[] {
  const db = getNodeSqliteKysely<PairingDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("channel_pairing_requests")
      .selectAll()
      .where("channel_key", "=", safeChannelKey(channel))
      .orderBy("created_at", "asc")
      .orderBy("account_id", "asc")
      .orderBy("request_id", "asc"),
  ).rows;
  return normalizePairingRequestRows(rows);
}

export function readChannelPairingSnapshotFromDatabase(
  database: OpenClawStateDatabase,
  channel: PairingChannel,
) {
  const db = getNodeSqliteKysely<PairingDatabase>(database.db);
  const channelKey = safeChannelKey(channel);
  // Both row families share one statement snapshot; unused fields only align the union.
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("channel_pairing_requests")
      .select((eb) => [
        "channel_key",
        "account_id",
        "request_id as record_id",
        "code",
        "created_at",
        "last_seen_at",
        "meta_json",
        eb.val(0).as("sort_order"),
        eb.val(0).as("updated_at"),
        eb.val<"request" | "allow">("request").as("kind"),
      ])
      .where("channel_key", "=", channelKey)
      .unionAll(
        db
          .selectFrom("channel_pairing_allow_entries")
          .select((eb) => [
            "channel_key",
            "account_id",
            "entry as record_id",
            eb.val("").as("code"),
            eb.val("").as("created_at"),
            eb.val("").as("last_seen_at"),
            eb.val(null).as("meta_json"),
            "sort_order",
            "updated_at",
            eb.val<"request" | "allow">("allow").as("kind"),
          ])
          .where("channel_key", "=", channelKey),
      )
      .orderBy("kind", "asc")
      .orderBy("created_at", "asc")
      .orderBy("account_id", "asc")
      .orderBy("sort_order", "asc")
      .orderBy("record_id", "asc"),
  ).rows;
  const requestRows: PairingRequestRow[] = [];
  const allowRows: PairingAllowRow[] = [];
  for (const row of rows) {
    if (row.kind === "request") {
      requestRows.push({
        channel_key: row.channel_key,
        account_id: row.account_id,
        request_id: row.record_id,
        code: row.code,
        created_at: row.created_at,
        last_seen_at: row.last_seen_at,
        meta_json: row.meta_json,
      });
    } else {
      allowRows.push({
        channel_key: row.channel_key,
        account_id: row.account_id,
        entry: row.record_id,
        sort_order: row.sort_order,
        updated_at: row.updated_at,
      });
    }
  }
  const requests = normalizePairingRequestRows(requestRows);
  const allowFrom: Record<string, string[]> = {};
  for (const row of allowRows) {
    (allowFrom[resolveAllowFromAccountId(row.account_id)] ??= []).push(row.entry);
  }
  const state: ChannelPairingState = { version: 1, requests, allowFrom };
  return { state, requestRows, allowRows };
}

export function writeChannelPairingStateToDatabase(
  database: OpenClawStateDatabase,
  channel: PairingChannel,
  state: ChannelPairingState,
): void {
  const db = getNodeSqliteKysely<PairingDatabase>(database.db);
  const channelKey = safeChannelKey(channel);
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("channel_pairing_requests").where("channel_key", "=", channelKey),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("channel_pairing_allow_entries").where("channel_key", "=", channelKey),
  );
  for (const request of state.requests) {
    const normalized = normalizePersistedPairingRequest(request);
    if (!normalized) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db.insertInto("channel_pairing_requests").values({
        channel_key: channelKey,
        account_id: resolvePairingRequestAccountId(normalized),
        request_id: normalized.id,
        code: normalized.code,
        created_at: normalized.createdAt,
        last_seen_at: normalized.lastSeenAt,
        meta_json: normalized.meta ? JSON.stringify(normalized.meta) : null,
      }),
    );
  }
  const updatedAt = Date.now();
  for (const [accountId, entries] of Object.entries(state.allowFrom ?? {})) {
    const normalizedEntries = dedupePreserveOrder(
      entries
        .map((entry) => normalizeOptionalString(entry) ?? "")
        .filter((entry) => entry && entry !== "*"),
    );
    for (const [sortOrder, entry] of normalizedEntries.entries()) {
      executeSqliteQuerySync(
        database.db,
        db.insertInto("channel_pairing_allow_entries").values({
          channel_key: channelKey,
          account_id: resolveAllowFromAccountId(accountId),
          entry,
          sort_order: sortOrder,
          updated_at: updatedAt,
        }),
      );
    }
  }
}

export function updateChannelPairingStateSnapshot<T>(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
  update: (state: ChannelPairingState) => T,
): T {
  return runOpenClawStateWriteTransaction(
    (database) => {
      const state = readChannelPairingSnapshotFromDatabase(database, channel).state;
      const result = update(state);
      writeChannelPairingStateToDatabase(database, channel, state);
      return result;
    },
    { env },
  );
}
