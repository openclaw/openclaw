import { randomUUID } from "node:crypto";
import path from "node:path";
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
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
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
    throw new Error("Doctor ingress import requires normalized channel and account IDs");
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
