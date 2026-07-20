// Durable local watches and update history for accepted marketplace feeds.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
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
import {
  parseOfficialExternalPluginCatalogShardRoot,
  parseOfficialExternalPluginCatalogShardedSnapshot,
  validateOfficialExternalPluginCatalogShardSet,
} from "./official-external-plugin-catalog-shards.js";
import {
  isOfficialExternalPluginCatalogFeed,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginLabel,
  type OfficialExternalPluginCatalogEntry,
  type OfficialExternalPluginCatalogFeed,
} from "./official-external-plugin-catalog.js";

const MAX_MARKETPLACE_FEED_WATCHES = 500;
const MAX_MARKETPLACE_FEED_UPDATES = 500;
const DEFAULT_MARKETPLACE_FEED_UPDATE_LIMIT = 50;
const MAX_MARKETPLACE_FEED_UPDATE_LIMIT = 100;

export type MarketplaceFeedItemKind = "plugin" | "skill";
export type MarketplaceFeedUpdateReason =
  | "updated"
  | "removed"
  | "blocked"
  | "security-state-changed";

export type MarketplaceFeedWatch = {
  feedId: string;
  feedProfile?: string;
  feedUrl: string;
  itemKind: MarketplaceFeedItemKind;
  itemId: string;
  lastSequence: number;
  muted: boolean;
  createdAt: number;
  updatedAt: number;
};

export type MarketplaceFeedUpdate = {
  eventId: string;
  feedId: string;
  itemKind: MarketplaceFeedItemKind;
  itemId: string;
  feedSequence: number;
  reason: MarketplaceFeedUpdateReason;
  title?: string;
  itemVersion?: string;
  itemState?: string;
  observedAt: number;
  readAt?: number;
  dismissedAt?: number;
};

export type MarketplaceFeedWatchStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDatabasePath?: string;
};

type MarketplaceFeedDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "marketplace_feed_updates" | "marketplace_feed_watches"
>;

type MarketplaceFeedWatchRow = {
  feed_id: string;
  feed_profile: string | null;
  feed_url: string;
  item_kind: string;
  item_id: string;
  baseline_json: string | null;
  last_sequence: number | bigint;
  muted: number | bigint;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

type MarketplaceFeedUpdateRow = {
  event_id: string;
  feed_id: string;
  item_kind: string;
  item_id: string;
  feed_sequence: number | bigint;
  reason: string;
  title: string | null;
  item_version: string | null;
  item_state: string | null;
  observed_at_ms: number | bigint;
  read_at_ms: number | bigint | null;
  dismissed_at_ms: number | bigint | null;
};

function databaseOptions(options: MarketplaceFeedWatchStoreOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function stateDb(db: DatabaseSync) {
  return getNodeSqliteKysely<MarketplaceFeedDatabase>(db);
}

function toWatch(row: MarketplaceFeedWatchRow): MarketplaceFeedWatch {
  return {
    feedId: row.feed_id,
    ...(row.feed_profile ? { feedProfile: row.feed_profile } : {}),
    feedUrl: row.feed_url,
    itemKind: row.item_kind as MarketplaceFeedItemKind,
    itemId: row.item_id,
    lastSequence: Number(row.last_sequence),
    muted: Number(row.muted) === 1,
    createdAt: Number(row.created_at_ms),
    updatedAt: Number(row.updated_at_ms),
  };
}

function toUpdate(row: MarketplaceFeedUpdateRow): MarketplaceFeedUpdate {
  return {
    eventId: row.event_id,
    feedId: row.feed_id,
    itemKind: row.item_kind as MarketplaceFeedItemKind,
    itemId: row.item_id,
    feedSequence: Number(row.feed_sequence),
    reason: row.reason as MarketplaceFeedUpdateReason,
    ...(row.title ? { title: row.title } : {}),
    ...(row.item_version ? { itemVersion: row.item_version } : {}),
    ...(row.item_state ? { itemState: row.item_state } : {}),
    observedAt: Number(row.observed_at_ms),
    ...(row.read_at_ms === null ? {} : { readAt: Number(row.read_at_ms) }),
    ...(row.dismissed_at_ms === null ? {} : { dismissedAt: Number(row.dismissed_at_ms) }),
  };
}

function selectWatchRows(db: DatabaseSync): MarketplaceFeedWatchRow[] {
  return executeSqliteQuerySync(
    db,
    stateDb(db)
      .selectFrom("marketplace_feed_watches")
      .selectAll()
      .orderBy("feed_id")
      .orderBy("item_kind")
      .orderBy("item_id"),
  ).rows;
}

export function listMarketplaceFeedWatches(
  options: MarketplaceFeedWatchStoreOptions = {},
): MarketplaceFeedWatch[] {
  const { db } = openOpenClawStateDatabase(databaseOptions(options));
  return selectWatchRows(db).map(toWatch);
}

export function addMarketplaceFeedWatch(
  watch: {
    feedId: string;
    feedProfile?: string;
    feedUrl: string;
    itemKind: MarketplaceFeedItemKind;
    itemId: string;
    sequence: number;
    baselineEntry: OfficialExternalPluginCatalogEntry;
  },
  options: MarketplaceFeedWatchStoreOptions = {},
): { created: boolean; watch: MarketplaceFeedWatch } {
  const now = Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      stateDb(db)
        .selectFrom("marketplace_feed_watches")
        .selectAll()
        .where("feed_id", "=", watch.feedId)
        .where("item_kind", "=", watch.itemKind)
        .where("item_id", "=", watch.itemId),
    ) as MarketplaceFeedWatchRow | undefined;
    if (existing) {
      return { created: false, watch: toWatch(existing) };
    }
    if (selectWatchRows(db).length >= MAX_MARKETPLACE_FEED_WATCHES) {
      throw new Error(`marketplace feed watch limit reached (${MAX_MARKETPLACE_FEED_WATCHES})`);
    }
    executeSqliteQuerySync(
      db,
      stateDb(db)
        .insertInto("marketplace_feed_watches")
        .values({
          feed_id: watch.feedId,
          feed_profile: watch.feedProfile ?? null,
          feed_url: watch.feedUrl,
          item_kind: watch.itemKind,
          item_id: watch.itemId,
          baseline_json: stableStringify(watch.baselineEntry),
          last_sequence: watch.sequence,
          muted: 0,
          created_at_ms: now,
          updated_at_ms: now,
        }),
    );
    return {
      created: true,
      watch: {
        feedId: watch.feedId,
        ...(watch.feedProfile ? { feedProfile: watch.feedProfile } : {}),
        feedUrl: watch.feedUrl,
        itemKind: watch.itemKind,
        itemId: watch.itemId,
        lastSequence: watch.sequence,
        muted: false,
        createdAt: now,
        updatedAt: now,
      },
    };
  }, databaseOptions(options));
}

export function removeMarketplaceFeedWatch(
  key: { feedId: string; itemKind: MarketplaceFeedItemKind; itemId: string },
  options: MarketplaceFeedWatchStoreOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      stateDb(db)
        .deleteFrom("marketplace_feed_watches")
        .where("feed_id", "=", key.feedId)
        .where("item_kind", "=", key.itemKind)
        .where("item_id", "=", key.itemId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, databaseOptions(options));
}

export function setMarketplaceFeedWatchMuted(
  key: { feedId: string; itemKind: MarketplaceFeedItemKind; itemId: string; muted: boolean },
  options: MarketplaceFeedWatchStoreOptions = {},
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      stateDb(db)
        .updateTable("marketplace_feed_watches")
        .set({ muted: key.muted ? 1 : 0, updated_at_ms: Date.now() })
        .where("feed_id", "=", key.feedId)
        .where("item_kind", "=", key.itemKind)
        .where("item_id", "=", key.itemId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, databaseOptions(options));
}

function boundedUpdateLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MARKETPLACE_FEED_UPDATE_LIMIT;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_MARKETPLACE_FEED_UPDATE_LIMIT) {
    throw new Error(
      `marketplace feed update limit must be between 1 and ${MAX_MARKETPLACE_FEED_UPDATE_LIMIT}`,
    );
  }
  return value;
}

export function listMarketplaceFeedUpdates(
  query: { includeDismissed?: boolean; limit?: number; unreadOnly?: boolean } = {},
  options: MarketplaceFeedWatchStoreOptions = {},
): MarketplaceFeedUpdate[] {
  const { db } = openOpenClawStateDatabase(databaseOptions(options));
  let statement = stateDb(db)
    .selectFrom("marketplace_feed_updates")
    .selectAll()
    .orderBy("observed_at_ms", "desc")
    .orderBy("event_id", "desc")
    .limit(boundedUpdateLimit(query.limit));
  if (!query.includeDismissed) {
    statement = statement.where("dismissed_at_ms", "is", null);
  }
  if (query.unreadOnly) {
    statement = statement.where("read_at_ms", "is", null);
  }
  return executeSqliteQuerySync(db, statement).rows.map(toUpdate);
}

function updateEventTimestamp(
  eventId: string,
  field: "dismissed_at_ms" | "read_at_ms",
  options: MarketplaceFeedWatchStoreOptions,
): boolean {
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existing = executeSqliteQueryTakeFirstSync(
      db,
      stateDb(db)
        .selectFrom("marketplace_feed_updates")
        .selectAll()
        .where("event_id", "=", eventId),
    ) as MarketplaceFeedUpdateRow | undefined;
    if (!existing) {
      return false;
    }
    if (existing[field] !== null) {
      return true;
    }
    const result = executeSqliteQuerySync(
      db,
      stateDb(db)
        .updateTable("marketplace_feed_updates")
        .set({ [field]: Date.now() })
        .where("event_id", "=", eventId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, databaseOptions(options));
}

export function markMarketplaceFeedUpdateRead(
  eventId: string,
  options: MarketplaceFeedWatchStoreOptions = {},
): boolean {
  return updateEventTimestamp(eventId, "read_at_ms", options);
}

export function dismissMarketplaceFeedUpdate(
  eventId: string,
  options: MarketplaceFeedWatchStoreOptions = {},
): boolean {
  return updateEventTimestamp(eventId, "dismissed_at_ms", options);
}

function decodeFeedBody(body: string): OfficialExternalPluginCatalogFeed | undefined {
  try {
    const document = JSON.parse(body) as { payload?: unknown };
    const snapshot = parseOfficialExternalPluginCatalogShardedSnapshot(document);
    if (snapshot) {
      const rootEnvelope = JSON.parse(snapshot.rootBody) as { payload?: unknown };
      if (typeof rootEnvelope.payload !== "string") {
        return undefined;
      }
      const root = parseOfficialExternalPluginCatalogShardRoot(
        JSON.parse(Buffer.from(rootEnvelope.payload, "base64url").toString("utf8")),
      );
      return validateOfficialExternalPluginCatalogShardSet(root, snapshot.shardBodies);
    }
    const candidate =
      typeof document.payload === "string"
        ? JSON.parse(
            Buffer.from(
              document.payload.replace(/-/gu, "+").replace(/_/gu, "/"),
              "base64",
            ).toString("utf8"),
          )
        : document;
    return isOfficialExternalPluginCatalogFeed(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function entriesById(
  feed: OfficialExternalPluginCatalogFeed,
): Map<string, OfficialExternalPluginCatalogEntry> {
  const entries = new Map<string, OfficialExternalPluginCatalogEntry>();
  for (const entry of feed.entries) {
    const id = resolveOfficialExternalPluginId(entry);
    if (id) {
      entries.set(id, entry);
    }
  }
  return entries;
}

function decodeBaselineEntry(body: string | null): OfficialExternalPluginCatalogEntry | undefined {
  if (body === null) {
    return undefined;
  }
  try {
    return JSON.parse(body) as OfficialExternalPluginCatalogEntry;
  } catch {
    return undefined;
  }
}

function classifyChange(
  previous: OfficialExternalPluginCatalogEntry | undefined,
  next: OfficialExternalPluginCatalogEntry | undefined,
): MarketplaceFeedUpdateReason | undefined {
  if (!previous) {
    return undefined;
  }
  if (!next) {
    return "removed";
  }
  if (next.state === "blocked" && previous.state !== "blocked") {
    return "blocked";
  }
  if (
    stableStringify({ publisher: previous.publisher, state: previous.state }) !==
    stableStringify({ publisher: next.publisher, state: next.state })
  ) {
    return "security-state-changed";
  }
  if (
    stableStringify({
      install: previous.install,
      name: previous.name,
      version: previous.version,
    }) !== stableStringify({ install: next.install, name: next.name, version: next.version })
  ) {
    return "updated";
  }
  return undefined;
}

function buildEventId(params: {
  feedId: string;
  itemId: string;
  sequence: number;
  reason: MarketplaceFeedUpdateReason;
}): string {
  return createHash("sha256")
    .update(`${params.feedId}\0plugin\0${params.itemId}\0${params.sequence}\0${params.reason}`)
    .digest("hex");
}

function pruneUpdateHistory(db: DatabaseSync): void {
  const rows = executeSqliteQuerySync(
    db,
    stateDb(db)
      .selectFrom("marketplace_feed_updates")
      .select("event_id")
      .orderBy("observed_at_ms", "desc")
      .orderBy("event_id", "desc"),
  ).rows;
  const staleIds = rows.slice(MAX_MARKETPLACE_FEED_UPDATES).map((row) => row.event_id);
  if (staleIds.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    db,
    stateDb(db).deleteFrom("marketplace_feed_updates").where("event_id", "in", staleIds),
  );
}

/** Materializes watched changes inside the same transaction as snapshot acceptance. */
export function materializeMarketplaceFeedWatchUpdates(params: {
  db: DatabaseSync;
  feedUrl: string;
  nextBody: string;
  now: number;
}): number {
  const nextFeed = decodeFeedBody(params.nextBody);
  if (!nextFeed) {
    return 0;
  }
  const db = stateDb(params.db);
  const watches = executeSqliteQuerySync(
    params.db,
    db
      .selectFrom("marketplace_feed_watches")
      .selectAll()
      .where("feed_id", "=", nextFeed.id)
      .where("feed_url", "=", params.feedUrl)
      .where("item_kind", "=", "plugin")
      .where("last_sequence", "<", nextFeed.sequence),
  ).rows;
  if (watches.length === 0) {
    return 0;
  }
  const nextEntries = entriesById(nextFeed);
  let created = 0;
  for (const watch of watches) {
    const next = nextEntries.get(watch.item_id);
    const reason = classifyChange(decodeBaselineEntry(watch.baseline_json), next);
    if (reason && watch.muted !== 1) {
      const result = executeSqliteQuerySync(
        params.db,
        db
          .insertInto("marketplace_feed_updates")
          .orIgnore()
          .values({
            event_id: buildEventId({
              feedId: nextFeed.id,
              itemId: watch.item_id,
              sequence: nextFeed.sequence,
              reason,
            }),
            feed_id: nextFeed.id,
            item_kind: "plugin",
            item_id: watch.item_id,
            feed_sequence: nextFeed.sequence,
            reason,
            title: next ? resolveOfficialExternalPluginLabel(next) : null,
            item_version: next?.version ?? null,
            item_state: next?.state ?? null,
            observed_at_ms: params.now,
            read_at_ms: null,
            dismissed_at_ms: null,
          }),
      );
      created += Number(result.numAffectedRows ?? 0);
    }
    executeSqliteQuerySync(
      params.db,
      db
        .updateTable("marketplace_feed_watches")
        .set({
          baseline_json: next ? stableStringify(next) : null,
          last_sequence: nextFeed.sequence,
          updated_at_ms: params.now,
        })
        .where("feed_id", "=", nextFeed.id)
        .where("item_kind", "=", "plugin")
        .where("item_id", "=", watch.item_id),
    );
  }
  pruneUpdateHistory(params.db);
  return created;
}
