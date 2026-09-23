// SQLite media custody runs on the queue operation's admitted connection.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  expireStagingAndLoadDeliveryQueueEntriesInDatabase,
  upsertDeliveryQueueEntryInDatabase,
} from "../delivery-queue-sqlite.kernel.js";
import type { DeliveryQueueEntryState } from "../delivery-queue-sqlite.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { generateSecureUuid } from "../secure-random.js";
import {
  DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
  OUTBOUND_DELIVERY_QUEUE_NAME,
  LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
  OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
  OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
} from "./delivery-queue-namespaces.js";

type MediaStageEntry = DeliveryQueueEntryState & { artifacts: string[] };
type OutboundMediaEntry = DeliveryQueueEntryState & {
  payloads?: ReplyPayload[];
  preparedBatch?: {
    entries?: Array<{ status?: string; payload?: ReplyPayload }>;
  };
};

function entryPayloads(entry: OutboundMediaEntry): ReplyPayload[] {
  if (Array.isArray(entry.payloads)) {
    return entry.payloads;
  }
  return (entry.preparedBatch?.entries ?? []).flatMap((prepared) =>
    prepared.status === "accepted" && prepared.payload ? [prepared.payload] : [],
  );
}

export function createDeliveryQueueMediaRetentionInDatabase(
  database: OpenClawStateDatabase,
  artifacts: readonly string[],
  entryKind: "outbound-media-stage" | "outbound-media-recovery-lease",
  prepared = { id: generateSecureUuid(), enqueuedAt: Date.now() },
): string {
  const { id, enqueuedAt } = prepared;
  const entry: MediaStageEntry = {
    id,
    enqueuedAt,
    retryCount: 0,
    artifacts: [...artifacts],
  };
  const insert = {
    queueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    entry,
    metadata: { entryKind },
    insertOnly: true,
  };
  const inserted = upsertDeliveryQueueEntryInDatabase(insert, database);
  if (!inserted) {
    throw new Error(`Delivery queue media stage already exists: ${id}`);
  }
  return id;
}

/**
 * Atomically expire abandoned stages and return every artifact still owned by
 * either a replayable outbound row or a producer that may still commit one.
 */
export function loadDeliveryQueueMediaRetentionSnapshotInDatabase(
  database: OpenClawStateDatabase,
  params: {
    expireBeforeMs: number;
  },
): { payloads: ReplyPayload[][]; stagedArtifacts: string[] } {
  const snapshot = expireStagingAndLoadDeliveryQueueEntriesInDatabase(database, {
    queueNames: [
      OUTBOUND_DELIVERY_QUEUE_NAME,
      LEGACY_OUTBOUND_DELIVERY_QUEUE_NAME,
      OUTBOUND_LEGACY_PREPARATION_QUEUE_NAME,
      OUTBOUND_DELIVERY_MIGRATION_QUEUE_NAME,
    ],
    stagingQueueName: DELIVERY_QUEUE_MEDIA_STAGING_QUEUE_NAME,
    expireBeforeMs: params.expireBeforeMs,
  });
  // A failed migration backup still owns its original media, even without a runnable row.
  // The migration receipt releases this custody only after all copies are verified and recorded.
  const { rows: migrationRows } = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<DB, "migration_sources">>(database.db)
      .selectFrom("migration_sources")
      .select("report_json")
      .where("migration_kind", "=", "delivery-queues")
      .where("removed_source", "=", 0),
  );
  const migrationMedia = migrationRows.flatMap((row) => {
    const report = asNullableRecord(JSON.parse(row.report_json));
    if (report?.mediaPreserved === true) {
      return [];
    }
    const paths = report?.mediaPaths;
    if (!Array.isArray(paths) || !paths.every((value) => typeof value === "string")) {
      throw new Error("Cannot safely collect queue media with an invalid migration receipt");
    }
    return paths;
  });
  return {
    // SAFETY: These outbound namespaces retain the legacy payload or prepared-batch shapes handled above.
    payloads: snapshot.entries.map((entry) => entryPayloads(entry as OutboundMediaEntry)),
    stagedArtifacts: snapshot.stagingEntries
      .flatMap((entry) => {
        // SAFETY: Staging rows own artifacts; the array and each string are checked before use.
        const artifacts = (entry as MediaStageEntry).artifacts;
        return Array.isArray(artifacts)
          ? artifacts.filter((artifact): artifact is string => typeof artifact === "string")
          : [];
      })
      .concat(migrationMedia),
  };
}
