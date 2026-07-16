import { existsSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { PublisherFeedEntry } from "./publisher-feed-projections.js";
import type {
  PublisherFeedState,
  PublisherFeedVerificationEvidence,
} from "./publisher-feed-transport.js";

export type StoredPublisherFeedState = {
  sourceOrigin: string;
  state: PublisherFeedState;
  verification: PublisherFeedVerificationEvidence;
  verifiedAt: string;
};

export type PublisherFeedStateStore = {
  read: (sourceOrigin: string, publisherId: string) => Promise<StoredPublisherFeedState | null>;
  write: (record: StoredPublisherFeedState) => Promise<void>;
};

type PublisherFeedStateStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
};

type PublisherFeedStateDatabase = Pick<OpenClawStateKyselyDatabase, "publisher_feed_states">;

type PublisherFeedStateRow = {
  source_origin: string;
  publisher_id: string;
  feed_id: string;
  sequence: number | bigint;
  generated_at: string;
  handle: string | null;
  display_name: string;
  entries_json: string;
  signed_by: string;
  signed_by_key_ids_json: string;
  signature_count: number | bigint;
  threshold: number | bigint;
  verified_at: string;
};

function resolveStoreEnv(options: PublisherFeedStateStoreOptions): NodeJS.ProcessEnv | undefined {
  if (!options.stateDir) {
    return options.env;
  }
  return { ...(options.env ?? process.env), OPENCLAW_STATE_DIR: options.stateDir };
}

function resolveDatabaseOptions(
  options: PublisherFeedStateStoreOptions,
): OpenClawStateDatabaseOptions {
  const env = resolveStoreEnv(options);
  return {
    ...(env ? { env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function resolveDatabasePath(options: PublisherFeedStateStoreOptions): string {
  return (
    options.stateDatabasePath ??
    resolveOpenClawStateSqlitePath(resolveStoreEnv(options) ?? process.env)
  );
}

function normalizeSourceOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("publisher feed source origin is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("publisher feed source must be an HTTPS origin");
  }
  return url.origin;
}

function isSafeEntryUrl(raw: string): boolean {
  if (raw.startsWith("/")) {
    if (raw.startsWith("//") || raw.includes("\\")) {
      return false;
    }
    for (let index = 0; index < raw.length; index += 1) {
      const codeUnit = raw.charCodeAt(index);
      if (codeUnit <= 0x1f || codeUnit === 0x7f) {
        return false;
      }
    }
    return true;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isEntry(value: unknown): value is PublisherFeedEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    Object.keys(entry).toSorted().join("\0") ===
      ["kind", "id", "name", "displayName", "summary", "url", "updatedAt"].toSorted().join("\0") &&
    (entry.kind === "skill" || entry.kind === "plugin") &&
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.displayName === "string" &&
    entry.displayName.length > 0 &&
    (entry.summary === null || typeof entry.summary === "string") &&
    typeof entry.url === "string" &&
    entry.url.length > 0 &&
    isSafeEntryUrl(entry.url) &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    entry.updatedAt >= 0
  );
}

function parseStringArray(raw: string): string[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
  } catch {
    return null;
  }
}

function parseEntries(raw: string): PublisherFeedEntry[] | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.length <= 400 && value.every(isEntry) ? value : null;
  } catch {
    return null;
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(left: PublisherFeedEntry, right: PublisherFeedEntry): number {
  return (
    right.updatedAt - left.updatedAt ||
    compareCodeUnits(left.kind, right.kind) ||
    compareCodeUnits(left.id, right.id)
  );
}

function assertRecord(record: StoredPublisherFeedState): StoredPublisherFeedState {
  const sourceOrigin = normalizeSourceOrigin(record.sourceOrigin);
  if (
    !record.state.publisherId ||
    new TextEncoder().encode(record.state.publisherId).length > 200 ||
    record.state.feedId !== `clawhub.publisher.${record.state.publisherId}` ||
    !Number.isSafeInteger(record.state.sequence) ||
    record.state.sequence < 0 ||
    !Number.isFinite(Date.parse(record.state.generatedAt)) ||
    (record.state.handle !== null && !record.state.handle) ||
    !record.state.displayName ||
    record.state.entries.length > 400 ||
    !record.state.entries.every(isEntry) ||
    !record.verification.signedBy ||
    record.verification.signedByKeyIds.length === 0 ||
    record.verification.signedByKeyIds.some((keyId) => !keyId) ||
    !record.verification.signedByKeyIds.includes(record.verification.signedBy) ||
    !Number.isSafeInteger(record.verification.signatureCount) ||
    record.verification.signatureCount < 1 ||
    !Number.isSafeInteger(record.verification.threshold) ||
    record.verification.threshold < 1 ||
    record.verification.signatureCount < record.verification.threshold ||
    !Number.isFinite(Date.parse(record.verifiedAt))
  ) {
    throw new Error("publisher feed state record is invalid");
  }
  const identities = new Set<string>();
  for (const entry of record.state.entries) {
    const identity = `${entry.kind}\0${entry.id}`;
    if (identities.has(identity)) {
      throw new Error("publisher feed state contains duplicate entries");
    }
    identities.add(identity);
  }
  return {
    ...record,
    sourceOrigin,
    state: {
      ...record.state,
      entries: [...record.state.entries].toSorted(compareEntries),
    },
    verification: {
      ...record.verification,
      signedByKeyIds: [...new Set(record.verification.signedByKeyIds)].toSorted(),
    },
  };
}

function rowToRecord(row: PublisherFeedStateRow | undefined): StoredPublisherFeedState | null {
  if (!row) {
    return null;
  }
  const entries = parseEntries(row.entries_json);
  const signedByKeyIds = parseStringArray(row.signed_by_key_ids_json);
  if (!entries || !signedByKeyIds) {
    throw new Error("stored publisher feed state is corrupt");
  }
  return assertRecord({
    sourceOrigin: row.source_origin,
    state: {
      feedId: row.feed_id,
      sequence: Number(row.sequence),
      generatedAt: row.generated_at,
      publisherId: row.publisher_id,
      handle: row.handle,
      displayName: row.display_name,
      entries,
    },
    verification: {
      signedBy: row.signed_by,
      signedByKeyIds,
      signatureCount: Number(row.signature_count),
      threshold: Number(row.threshold),
    },
    verifiedAt: row.verified_at,
  });
}

function sameAcceptedState(row: PublisherFeedStateRow, record: StoredPublisherFeedState): boolean {
  return (
    row.feed_id === record.state.feedId &&
    row.generated_at === record.state.generatedAt &&
    row.handle === record.state.handle &&
    row.display_name === record.state.displayName &&
    row.entries_json === JSON.stringify(record.state.entries)
  );
}

const SELECT_COLUMNS = [
  "source_origin",
  "publisher_id",
  "feed_id",
  "sequence",
  "generated_at",
  "handle",
  "display_name",
  "entries_json",
  "signed_by",
  "signed_by_key_ids_json",
  "signature_count",
  "threshold",
  "verified_at",
] as const;

export function createSqlitePublisherFeedStateStore(
  options: PublisherFeedStateStoreOptions = {},
): PublisherFeedStateStore {
  return {
    async read(sourceOrigin, publisherId) {
      const normalizedOrigin = normalizeSourceOrigin(sourceOrigin);
      const pathname = resolveDatabasePath(options);
      if (!existsSync(pathname)) {
        return null;
      }
      const database = openOpenClawStateDatabase(resolveDatabaseOptions(options));
      const stateDb = getNodeSqliteKysely<PublisherFeedStateDatabase>(database.db);
      const row = executeSqliteQueryTakeFirstSync(
        database.db,
        stateDb
          .selectFrom("publisher_feed_states")
          .select(SELECT_COLUMNS)
          .where("source_origin", "=", normalizedOrigin)
          .where("publisher_id", "=", publisherId),
      ) as PublisherFeedStateRow | undefined;
      return rowToRecord(row);
    },
    async write(input) {
      const record = assertRecord(input);
      const entriesJson = JSON.stringify(record.state.entries);
      const keyIdsJson = JSON.stringify(record.verification.signedByKeyIds);
      const now = Date.now();
      runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<PublisherFeedStateDatabase>(database.db);
        const current = executeSqliteQueryTakeFirstSync(
          database.db,
          stateDb
            .selectFrom("publisher_feed_states")
            .select(SELECT_COLUMNS)
            .where("source_origin", "=", record.sourceOrigin)
            .where("publisher_id", "=", record.state.publisherId),
        ) as PublisherFeedStateRow | undefined;
        if (current && Number(current.sequence) > record.state.sequence) {
          throw new Error("publisher feed state sequence is older than accepted state");
        }
        if (
          current &&
          Number(current.sequence) === record.state.sequence &&
          !sameAcceptedState(current, record)
        ) {
          throw new Error("publisher feed state changed without a sequence increment");
        }
        executeSqliteQuerySync(
          database.db,
          stateDb
            .insertInto("publisher_feed_states")
            .values({
              source_origin: record.sourceOrigin,
              publisher_id: record.state.publisherId,
              feed_id: record.state.feedId,
              sequence: record.state.sequence,
              generated_at: record.state.generatedAt,
              handle: record.state.handle,
              display_name: record.state.displayName,
              entries_json: entriesJson,
              signed_by: record.verification.signedBy,
              signed_by_key_ids_json: keyIdsJson,
              signature_count: record.verification.signatureCount,
              threshold: record.verification.threshold,
              verified_at: record.verifiedAt,
              updated_at_ms: now,
            })
            .onConflict((conflict) =>
              conflict.columns(["source_origin", "publisher_id"]).doUpdateSet({
                feed_id: record.state.feedId,
                sequence: record.state.sequence,
                generated_at: record.state.generatedAt,
                handle: record.state.handle,
                display_name: record.state.displayName,
                entries_json: entriesJson,
                signed_by: record.verification.signedBy,
                signed_by_key_ids_json: keyIdsJson,
                signature_count: record.verification.signatureCount,
                threshold: record.verification.threshold,
                verified_at: record.verifiedAt,
                updated_at_ms: now,
              }),
            ),
        );
      }, resolveDatabaseOptions(options));
    },
  };
}
