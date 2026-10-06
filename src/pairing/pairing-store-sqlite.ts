// Internal SQLite persistence for channel pairing requests and allow entries.
import type { DatabaseSync } from "node:sqlite";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  dedupePreserveOrder,
  resolveAllowFromAccountId,
  safeChannelKey,
} from "./pairing-store-keys.js";
import type { PairingChannel, PairingRequestRecord } from "./pairing-store.types.js";

type PairingRequest = PairingRequestRecord;

type PairingDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_pairing_allow_entries" | "channel_pairing_requests"
>;

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

function normalizePersistedPairingRequest(value: unknown): PairingRequest | undefined {
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

export function resolvePairingRequestAccountId(entry: PairingRequest): string {
  return resolveAllowFromAccountId(entry.meta?.accountId);
}

function readChannelAllowEntries(database: DatabaseSync, channel: PairingChannel) {
  const db = getNodeSqliteKysely<PairingDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("channel_pairing_allow_entries")
      .selectAll()
      .where("channel_key", "=", safeChannelKey(channel))
      .orderBy("account_id", "asc")
      .orderBy("sort_order", "asc")
      .orderBy("entry", "asc"),
  ).rows;
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

export function readChannelPairingStateFromDatabase(
  database: OpenClawStateDatabase,
  channel: PairingChannel,
): ChannelPairingState {
  const db = getNodeSqliteKysely<PairingDatabase>(database.db);
  const channelKey = safeChannelKey(channel);
  const requestRows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("channel_pairing_requests")
      .selectAll()
      .where("channel_key", "=", channelKey)
      .orderBy("created_at", "asc")
      .orderBy("account_id", "asc")
      .orderBy("request_id", "asc"),
  ).rows;
  const allowFrom = readChannelAllowEntries(database.db, channel);
  const requests = requestRows.flatMap((row) => {
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
  return { version: 1, requests, allowFrom };
}

export function readChannelPairingState(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv,
): ChannelPairingState {
  return readChannelPairingStateFromDatabase(openOpenClawStateDatabase({ env }), channel);
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
      const state = readChannelPairingStateFromDatabase(database, channel);
      const result = update(state);
      writeChannelPairingStateToDatabase(database, channel, state);
      return result;
    },
    { env },
  );
}
