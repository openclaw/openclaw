import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  markLegacyMigrationSourceRemovedInDatabase,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "../../infra/state-migrations.receipts.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveChannelIngressStateEnv } from "./ingress-queue-client.js";

export type ChannelIngressLegacyEntry = {
  id: string;
  receivedAt: number;
} & (
  | { status: "pending"; payload: unknown }
  | { status: "failed"; reason: string; message?: string; failedAt: number }
);

export type ChannelIngressLegacyImportResult = {
  imported: string[];
  present: string[];
  conflicts: string[];
  markSourcesRemoved: (sourcePaths: readonly string[]) => void;
};

export type ChannelIngressLegacyImport = {
  entry: ChannelIngressLegacyEntry;
  sources: readonly { sourcePath: string; sha256: string; size: number }[];
};

export type ChannelIngressLegacyPendingEntry = {
  id: string;
  accountId: string;
  receivedAt: number;
  payload: unknown;
};

function legacyPendingEntries(
  db: DatabaseSync,
  channelId: string,
): ChannelIngressLegacyPendingEntry[] {
  const query = getNodeSqliteKysely<DB>(db)
    .selectFrom("channel_ingress_events as event")
    .innerJoin("migration_sources as source", (join) =>
      join.on((eb) =>
        eb.and([
          eb("source.migration_kind", "=", "channel-ingress"),
          eb("source.target_table", "=", "channel_ingress_events"),
          eb(
            eb.fn<string>("json_extract", ["source.report_json", eb.val("$.queueName")]),
            "=",
            eb.ref("event.queue_name"),
          ),
          eb(
            eb.fn<string>("json_extract", ["source.report_json", eb.val("$.eventId")]),
            "=",
            eb.ref("event.event_id"),
          ),
        ]),
      ),
    )
    .select([
      "event.event_id as id",
      "event.account_id as accountId",
      "event.received_at as receivedAt",
      "event.payload_json as payloadJson",
    ])
    .distinct()
    .where("event.channel_id", "=", channelId)
    .where("event.status", "=", "pending")
    .orderBy("event.queue_name")
    .orderBy("event.event_id");
  return executeSqliteQuerySync(db, query).rows.map(
    ({ id, accountId, receivedAt, payloadJson }) => ({
      id,
      accountId,
      receivedAt,
      payload: JSON.parse(payloadJson) as unknown,
    }),
  );
}

/** Migration-only inspection: a receipt, not the payload shape, proves legacy origin. */
export function listLegacyPendingChannelIngressEntries(params: {
  channelId: string;
  stateDir: string;
}): ChannelIngressLegacyPendingEntry[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => legacyPendingEntries(db, params.channelId),
      { env: resolveChannelIngressStateEnv(params.stateDir) },
    ) ?? []
  );
}

/** The offline migration owner supplies age policy; receipts and original bytes survive. */
export async function retireLegacyChannelIngressEntries(params: {
  channelId: string;
  stateDir: string;
  entries: readonly ChannelIngressLegacyPendingEntry[];
  reason: string;
  failedAt: number;
  assertCurrent: () => void;
}): Promise<{
  entries: ChannelIngressLegacyPendingEntry[];
  changes: string[];
  warnings: string[];
}> {
  params.assertCurrent();
  const env = resolveChannelIngressStateEnv(params.stateDir);
  const entries = [...params.entries];
  if (!entries.length) {
    return { entries, changes: [], warnings: [] };
  }
  const validate = (db: DatabaseSync) => {
    const keys = new Set(entries.map((entry) => JSON.stringify([entry.accountId, entry.id])));
    const current = legacyPendingEntries(db, params.channelId).filter((entry) =>
      keys.has(JSON.stringify([entry.accountId, entry.id])),
    );
    if (!isDeepStrictEqual(current, entries)) {
      throw new Error(
        "Legacy ingress changed during Doctor repair; inspect again before retrying.",
      );
    }
  };
  const { backupDoctorSqliteDatabases } = await import("../../commands/doctor-migration-backup.js");
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const backup = await backupDoctorSqliteDatabases({
    env,
    pendingDatabasePaths: [databasePath],
    databasePaths: [databasePath],
    authority: { assertCurrent: params.assertCurrent },
    repair: {
      key: createHash("sha256")
        .update(JSON.stringify([params.channelId, params.reason, entries]))
        .digest("hex"),
      validate,
    },
  });
  params.assertCurrent();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent();
      validate(db);
      const kysely = getNodeSqliteKysely<DB>(db);
      for (const entry of entries) {
        executeSqliteQuerySync(
          db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "failed",
              payload_json: "null",
              metadata_json: null,
              last_error: null,
              failed_reason: params.reason,
              failed_at: params.failedAt,
              updated_at: params.failedAt,
            })
            .where("channel_id", "=", params.channelId)
            .where("account_id", "=", entry.accountId)
            .where("event_id", "=", entry.id)
            .where("status", "=", "pending"),
        );
      }
      params.assertCurrent();
    },
    { env },
    { operationLabel: "doctor retire legacy ingress" },
  );
  return { entries, ...backup };
}

/** Offline Doctor import: failure tombstones must never pass through pending state. */
export function importLegacyChannelIngressEntries(params: {
  channelId: string;
  accountId: string;
  stateDir: string;
  entries: readonly ChannelIngressLegacyImport[];
  assertCurrent: () => void;
}): ChannelIngressLegacyImportResult {
  params.assertCurrent();
  const { channelId, accountId } = params;
  if (
    !channelId ||
    channelId !== channelId.trim() ||
    !accountId ||
    accountId !== accountId.trim()
  ) {
    throw new Error("Doctor ingress import requires canonical channel and account IDs");
  }
  const queueName = JSON.stringify([params.channelId, accountId]);
  const seen = new Set<string>();
  const prepared = params.entries.map(({ entry, sources }) => {
    if (
      !entry.id ||
      entry.id !== entry.id.trim() ||
      seen.has(entry.id) ||
      !Number.isSafeInteger(entry.receivedAt) ||
      entry.receivedAt < 0 ||
      (entry.status === "failed" &&
        (!Number.isSafeInteger(entry.failedAt) || entry.failedAt < 0 || !entry.reason))
    ) {
      throw new Error(`Invalid legacy ingress entry ${entry.id}`);
    }
    seen.add(entry.id);
    const payloadJson = entry.status === "pending" ? JSON.stringify(entry.payload) : "null";
    if (payloadJson === undefined) {
      throw new Error(`Legacy ingress entry ${entry.id} has no JSON payload`);
    }
    if (!sources.length) {
      throw new Error(`Legacy ingress entry ${entry.id} has no verified source`);
    }
    const receipts = sources.map((source) => {
      if (
        !path.isAbsolute(source.sourcePath) ||
        path.resolve(source.sourcePath) !== source.sourcePath ||
        !/^[a-f0-9]{64}$/.test(source.sha256) ||
        !Number.isSafeInteger(source.size) ||
        source.size < 0
      ) {
        throw new Error(`Invalid legacy ingress source for ${entry.id}`);
      }
      return {
        source: { ...source },
        sourceKey: resolveLegacyMigrationSourceKey(
          "channel-ingress",
          source.sourcePath,
          JSON.stringify([queueName, entry.id, source.sha256, source.size]),
        ),
      };
    });
    return { entry, payloadJson, receipts };
  });
  const env = resolveChannelIngressStateEnv(params.stateDir);
  const committedSources = new Map<string, string>();
  const result: ChannelIngressLegacyImportResult = {
    imported: [],
    present: [],
    conflicts: [],
    markSourcesRemoved(sourcePaths) {
      params.assertCurrent();
      const keys = sourcePaths.map((sourcePath) => {
        const key = committedSources.get(sourcePath);
        if (!key) {
          throw new Error(`Legacy ingress source was not committed: ${sourcePath}`);
        }
        return key;
      });
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          params.assertCurrent();
          for (const key of keys) {
            markLegacyMigrationSourceRemovedInDatabase(db, key);
          }
          params.assertCurrent();
        },
        { env },
      );
    },
  };
  if (!prepared.length) {
    return result;
  }
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent();
      const now = Date.now();
      const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
      for (const { entry, payloadJson, receipts } of prepared) {
        const prior = receipts.filter(({ sourceKey, source }) => {
          const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
          if (!receipt) {
            return false;
          }
          const report: unknown = JSON.parse(receipt.reportJson);
          if (
            receipt.sourceSha256 !== source.sha256 ||
            !isRecord(report) ||
            report.queueName !== queueName ||
            report.eventId !== entry.id ||
            !isDeepStrictEqual(report.source, source) ||
            typeof report.disposition !== "string" ||
            !["imported", "equivalent", "completed"].includes(report.disposition) ||
            typeof report.status !== "string" ||
            !["pending", "claimed", "failed", "completed"].includes(report.status)
          ) {
            throw new Error(`Unverified legacy ingress receipt for ${source.sourcePath}`);
          }
          return true;
        });
        // Source receipts survive queue consumption, operator deletion, and tombstone pruning.
        if (prior.length) {
          if (prior.length !== receipts.length) {
            result.conflicts.push(entry.id);
            continue;
          }
          for (const { sourceKey, source } of receipts) {
            committedSources.set(source.sourcePath, sourceKey);
          }
          result.present.push(entry.id);
          continue;
        }
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("channel_ingress_events")
            .selectAll()
            .where("queue_name", "=", queueName)
            .where("event_id", "=", entry.id),
        );
        if (existing) {
          let matches = existing.status === "completed";
          if (existing.received_at === entry.receivedAt) {
            if (entry.status === "failed") {
              matches ||=
                existing.status === "failed" &&
                existing.payload_json === "null" &&
                existing.failed_reason === entry.reason &&
                existing.failed_at === entry.failedAt &&
                existing.last_error === (entry.message ?? null);
            } else if (existing.status === "pending" || existing.status === "claimed") {
              try {
                matches = isDeepStrictEqual(JSON.parse(existing.payload_json), entry.payload);
              } catch {
                matches = false;
              }
            }
          }
          if (!matches) {
            result.conflicts.push(entry.id);
            continue;
          }
          result.present.push(entry.id);
        } else {
          executeSqliteQuerySync(
            db,
            kysely.insertInto("channel_ingress_events").values({
              queue_name: queueName,
              event_id: entry.id,
              channel_id: params.channelId,
              account_id: accountId,
              status: entry.status,
              payload_json: payloadJson,
              metadata_json: null,
              received_at: entry.receivedAt,
              updated_at: now,
              attempts: 0,
              failed_at: entry.status === "failed" ? entry.failedAt : null,
              failed_reason: entry.status === "failed" ? entry.reason : null,
              last_error: entry.status === "failed" ? (entry.message ?? null) : null,
            }),
          );
          result.imported.push(entry.id);
        }
        for (const { sourceKey, source } of receipts) {
          recordLegacyMigrationReceipt(db, {
            sourceKey,
            migrationKind: "channel-ingress",
            sourcePath: source.sourcePath,
            targetTable: "channel_ingress_events",
            sourceSha256: source.sha256,
            sourceSizeBytes: source.size,
            sourceRecordCount: 1,
            runId: randomUUID(),
            now,
            reportJson: JSON.stringify({
              queueName,
              eventId: entry.id,
              source,
              status: existing?.status ?? entry.status,
              disposition: !existing
                ? "imported"
                : existing.status === "completed"
                  ? "completed"
                  : "equivalent",
            }),
          });
          committedSources.set(source.sourcePath, sourceKey);
        }
      }
      params.assertCurrent();
      return result;
    },
    { env },
    { operationLabel: "doctor channel ingress import" },
  );
}
