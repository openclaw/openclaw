/** Persists hosted official external plugin catalog snapshots in OpenClaw state. */
import { existsSync } from "node:fs";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type {
  HostedOfficialExternalPluginCatalogMetadata,
  HostedOfficialExternalPluginCatalogSnapshot,
  HostedOfficialExternalPluginCatalogSnapshotStore,
} from "./official-external-plugin-catalog.js";

export type HostedOfficialExternalPluginCatalogSnapshotStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  stateDatabasePath?: string;
};

type HostedCatalogSnapshotRow = {
  feed_url: string;
  body: string;
  status: number | bigint;
  etag: string | null;
  last_modified: string | null;
  checksum: string;
  saved_at: string;
};

function resolveStoreEnv(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): NodeJS.ProcessEnv | undefined {
  if (!options.stateDir) {
    return options.env;
  }
  return {
    ...(options.env ?? process.env),
    OPENCLAW_STATE_DIR: options.stateDir,
  };
}

function resolveStateDatabaseOptions(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): OpenClawStateDatabaseOptions {
  const env = resolveStoreEnv(options);
  return {
    ...(env ? { env } : {}),
    ...(options.stateDatabasePath ? { path: options.stateDatabasePath } : {}),
  };
}

function resolveStateDatabasePath(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions,
): string {
  if (options.stateDatabasePath) {
    return options.stateDatabasePath;
  }
  return resolveOpenClawStateSqlitePath(resolveStoreEnv(options) ?? process.env);
}

function rowToSnapshot(
  row: HostedCatalogSnapshotRow | undefined,
): HostedOfficialExternalPluginCatalogSnapshot | null {
  if (!row) {
    return null;
  }
  const metadata: HostedOfficialExternalPluginCatalogMetadata = {
    url: row.feed_url,
    status: Number(row.status),
    checksum: row.checksum,
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.last_modified ? { lastModified: row.last_modified } : {}),
  };
  return {
    body: row.body,
    metadata,
    savedAt: row.saved_at,
  };
}

/** Creates a snapshot store backed by the shared `state/openclaw.sqlite` database. */
export function createSqliteHostedOfficialExternalPluginCatalogSnapshotStore(
  options: HostedOfficialExternalPluginCatalogSnapshotStoreOptions = {},
): HostedOfficialExternalPluginCatalogSnapshotStore {
  return {
    async read(url) {
      const pathname = resolveStateDatabasePath(options);
      if (!existsSync(pathname)) {
        return null;
      }
      const database = openOpenClawStateDatabase(resolveStateDatabaseOptions(options));
      const row = database.db
        .prepare(
          `
            SELECT feed_url, body, status, etag, last_modified, checksum, saved_at
              FROM official_external_plugin_catalog_snapshots
             WHERE feed_url = ?
          `,
        )
        .get(url) as HostedCatalogSnapshotRow | undefined;
      return rowToSnapshot(row);
    },
    async write(snapshot) {
      const now = Date.now();
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(
          `
            INSERT INTO official_external_plugin_catalog_snapshots (
              feed_url, body, status, etag, last_modified, checksum, saved_at, updated_at_ms
            ) VALUES (
              @feed_url, @body, @status, @etag, @last_modified, @checksum, @saved_at, @updated_at_ms
            )
            ON CONFLICT(feed_url) DO UPDATE SET
              body = excluded.body,
              status = excluded.status,
              etag = excluded.etag,
              last_modified = excluded.last_modified,
              checksum = excluded.checksum,
              saved_at = excluded.saved_at,
              updated_at_ms = excluded.updated_at_ms
          `,
        ).run({
          feed_url: snapshot.metadata.url,
          body: snapshot.body,
          status: snapshot.metadata.status,
          etag: snapshot.metadata.etag ?? null,
          last_modified: snapshot.metadata.lastModified ?? null,
          checksum: snapshot.metadata.checksum,
          saved_at: snapshot.savedAt,
          updated_at_ms: now,
        });
      }, resolveStateDatabaseOptions(options));
    },
  };
}
