/** Bounded retention for durable ingress rows, including policy-drop replay guards. */
import { engineUnboundedRowLimit } from "../../infra/database-engine/row-limit.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { INGRESS_QUEUE_CAP_DROP_REASONS } from "./ingress-queue-cap-drop.js";
import type { ChannelIngressQueuePruneOptions } from "./ingress-queue.types.js";

export function pruneChannelIngressInDatabase(
  db: EngineConnection,
  input: {
    queueName: string;
    options: Omit<ChannelIngressQueuePruneOptions, "protectIds"> & { protectIds?: string[] };
    now: number;
  },
): number {
  const kysely = getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db);
  const protectedIds = (input.options.protectIds ?? []).map((id) => id.trim()).filter(Boolean);
  // Native text rows cannot match an unpaired surrogate through JS string equality.
  const protectedMaxIds = protectedIds.filter((id) => id.isWellFormed());
  let deleted = 0;
  const policies = [
    {
      status: "pending",
      column: "updated_at",
      ttl: input.options.pendingTtlMs,
      max: input.options.pendingMaxEntries,
    },
    {
      status: "completed",
      column: "completed_at",
      ttl: input.options.completedTtlMs,
      max: input.options.completedMaxEntries,
    },
    {
      status: "failed",
      column: "failed_at",
      ttl: input.options.failedTtlMs,
      max: input.options.failedMaxEntries,
      policyDrops: false,
    },
    {
      status: "failed",
      column: "failed_at",
      // The preceding policy applies the shared TTL to both failed-row partitions.
      ttl: undefined,
      max: input.options.failedMaxEntries,
      policyDrops: true,
    },
  ] as const;
  for (const policy of policies) {
    if (policy.ttl !== undefined) {
      let query = kysely
        .deleteFrom("channel_ingress_events")
        .where("queue_name", "=", input.queueName)
        .where("status", "=", policy.status)
        .where(policy.column, "<", input.now - policy.ttl);
      if (protectedIds.length) {
        query = query.where("event_id", "not in", protectedIds);
      }
      deleted += Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0n);
    }
    if (policy.max === undefined) {
      continue;
    }
    // Protected rows occupy their original retention slots.
    let overflow = kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", input.queueName)
      .where("status", "=", policy.status)
      .orderBy("updated_at", "desc")
      .orderBy("event_id", "desc")
      .limit(engineUnboundedRowLimit(db))
      .offset(Math.max(0, Math.floor(policy.max)));
    if (policy.status === "failed") {
      // Policy drops must not spend the retention slots for actual delivery failures.
      overflow = overflow.where((eb) =>
        policy.policyDrops
          ? eb("failed_reason", "in", INGRESS_QUEUE_CAP_DROP_REASONS)
          : eb.or([
              eb("failed_reason", "is", null),
              eb("failed_reason", "not in", INGRESS_QUEUE_CAP_DROP_REASONS),
            ]),
      );
    }
    let candidates = kysely.selectFrom(overflow.as("overflow")).select("event_id").limit(500);
    if (protectedMaxIds.length) {
      // Apply protection before the batch limit so a protected page cannot hide later overflow.
      candidates = candidates.where("event_id", "not in", sqliteStringSet(protectedMaxIds));
    }
    const query = kysely
      .deleteFrom("channel_ingress_events")
      .where("queue_name", "=", input.queueName)
      .where("status", "=", policy.status)
      .where("event_id", "in", candidates);
    while (true) {
      const removed = Number(executeSqliteQuerySync(db, query).numAffectedRows ?? 0n);
      if (!removed) {
        break;
      }
      deleted += removed;
    }
  }
  return deleted;
}
