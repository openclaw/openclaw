import { existsSync } from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export type FollowedPublisherFeed = {
  sourceOrigin: string;
  publisherId: string;
  feedProfile: string;
  createdAtMs: number;
  updatedAtMs: number;
};

export type PublisherFeedFollowStore = {
  list: () => Promise<FollowedPublisherFeed[]>;
  follow: (params: {
    sourceOrigin: string;
    publisherId: string;
    feedProfile: string;
    nowMs?: number;
  }) => Promise<FollowedPublisherFeed>;
  unfollow: (sourceOrigin: string, publisherId: string) => Promise<boolean>;
};

type PublisherFeedFollowStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
};

type PublisherFeedFollowDatabase = Pick<OpenClawStateKyselyDatabase, "publisher_feed_follows">;

type PublisherFeedFollowRow = {
  source_origin: string;
  publisher_id: string;
  feed_profile: string;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

function resolveStoreEnv(options: PublisherFeedFollowStoreOptions): NodeJS.ProcessEnv | undefined {
  if (!options.stateDir) {
    return options.env;
  }
  return { ...(options.env ?? process.env), OPENCLAW_STATE_DIR: options.stateDir };
}

function resolveDatabaseOptions(
  options: PublisherFeedFollowStoreOptions,
): OpenClawStateDatabaseOptions {
  const env = resolveStoreEnv(options);
  return {
    ...(env ? { env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function resolveDatabasePath(options: PublisherFeedFollowStoreOptions): string {
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

function normalizeBoundedText(raw: string, label: string, maxBytes: number): string {
  const value = raw.trim();
  if (!value || new TextEncoder().encode(value).length > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function normalizePublisherId(raw: string): string {
  return normalizeBoundedText(raw, "publisher id", 200);
}

function normalizeFeedProfile(raw: string): string {
  return normalizeBoundedText(raw, "publisher feed profile", 100);
}

function normalizeTimestamp(raw: number | bigint, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`stored publisher feed follow ${label} is invalid`);
  }
  return value;
}

function rowToFollow(row: PublisherFeedFollowRow): FollowedPublisherFeed {
  return {
    sourceOrigin: normalizeSourceOrigin(row.source_origin),
    publisherId: normalizePublisherId(row.publisher_id),
    feedProfile: normalizeFeedProfile(row.feed_profile),
    createdAtMs: normalizeTimestamp(row.created_at_ms, "creation time"),
    updatedAtMs: normalizeTimestamp(row.updated_at_ms, "update time"),
  };
}

const SELECT_COLUMNS = [
  "source_origin",
  "publisher_id",
  "feed_profile",
  "created_at_ms",
  "updated_at_ms",
] as const;

export function createSqlitePublisherFeedFollowStore(
  options: PublisherFeedFollowStoreOptions = {},
): PublisherFeedFollowStore {
  return {
    async list() {
      const pathname = resolveDatabasePath(options);
      if (!existsSync(pathname)) {
        return [];
      }
      const database = openOpenClawStateDatabase(resolveDatabaseOptions(options));
      const stateDb = getNodeSqliteKysely<PublisherFeedFollowDatabase>(database.db);
      const rows = executeSqliteQuerySync(
        database.db,
        stateDb
          .selectFrom("publisher_feed_follows")
          .select(SELECT_COLUMNS)
          .orderBy("source_origin", "asc")
          .orderBy("publisher_id", "asc"),
      ).rows as PublisherFeedFollowRow[];
      return rows.map(rowToFollow);
    },
    async follow(params) {
      const sourceOrigin = normalizeSourceOrigin(params.sourceOrigin);
      const publisherId = normalizePublisherId(params.publisherId);
      const feedProfile = normalizeFeedProfile(params.feedProfile);
      const nowMs = params.nowMs ?? Date.now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new Error("publisher feed follow time is invalid");
      }
      return runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<PublisherFeedFollowDatabase>(database.db);
        executeSqliteQuerySync(
          database.db,
          stateDb
            .insertInto("publisher_feed_follows")
            .values({
              source_origin: sourceOrigin,
              publisher_id: publisherId,
              feed_profile: feedProfile,
              created_at_ms: nowMs,
              updated_at_ms: nowMs,
            })
            .onConflict((conflict) =>
              conflict.columns(["source_origin", "publisher_id"]).doUpdateSet({
                feed_profile: feedProfile,
                updated_at_ms: nowMs,
              }),
            ),
        );
        const row = executeSqliteQuerySync(
          database.db,
          stateDb
            .selectFrom("publisher_feed_follows")
            .select(SELECT_COLUMNS)
            .where("source_origin", "=", sourceOrigin)
            .where("publisher_id", "=", publisherId),
        ).rows[0] as PublisherFeedFollowRow | undefined;
        if (!row) {
          throw new Error("publisher feed follow was not persisted");
        }
        return rowToFollow(row);
      }, resolveDatabaseOptions(options));
    },
    async unfollow(sourceOriginInput, publisherIdInput) {
      const sourceOrigin = normalizeSourceOrigin(sourceOriginInput);
      const publisherId = normalizePublisherId(publisherIdInput);
      return runOpenClawStateWriteTransaction((database) => {
        const stateDb = getNodeSqliteKysely<PublisherFeedFollowDatabase>(database.db);
        const existing = executeSqliteQuerySync(
          database.db,
          stateDb
            .selectFrom("publisher_feed_follows")
            .select("publisher_id")
            .where("source_origin", "=", sourceOrigin)
            .where("publisher_id", "=", publisherId),
        ).rows[0];
        if (!existing) {
          return false;
        }
        executeSqliteQuerySync(
          database.db,
          stateDb
            .deleteFrom("publisher_feed_follows")
            .where("source_origin", "=", sourceOrigin)
            .where("publisher_id", "=", publisherId),
        );
        return true;
      }, resolveDatabaseOptions(options));
    },
  };
}
