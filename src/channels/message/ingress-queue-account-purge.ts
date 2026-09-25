/** Discards the durable ingress rows a removed channel account owned. */
import { existsSync } from "node:fs";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import { resolveDatabasePath } from "../../state/openclaw-state-db-maintenance.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import {
  affectedRows,
  createStateDirEnv,
  getChannelIngressKysely,
  normalizePart,
  openChannelIngressDatabase,
  queueNameForParts,
} from "./ingress-queue.js";

/** Ingress rows dropped when a channel account is removed. */
export type ChannelIngressQueueAccountPurge = {
  /** Rows removed across every status. */
  discarded: number;
  /** Removed rows that were still awaiting an answer, so the removal dropped inbound work. */
  undelivered: number;
  /** Removed dead letters, which an operator could have resubmitted until now. */
  recoverable: number;
};

/**
 * Drops every ingress row a removed channel account owned.
 *
 * Retention prunes on admission, so an account that never admits again keeps its rows
 * forever; removal is the last point that can dispose of them. Callers report
 * `undelivered` and `recoverable` because those rows are inbound work, not residue.
 *
 * Selection is an exact match on the queue name, so a caller that cannot reproduce the
 * name a plugin composed removes nothing rather than something else: the failure
 * direction here is always "too few".
 */
export function purgeChannelIngressQueueAccount(params: {
  channelId: string;
  accountId?: string;
  stateDir?: string;
}): ChannelIngressQueueAccountPurge {
  const queueName = queueNameForParts(
    normalizePart(params.channelId, "unknown"),
    normalizePart(params.accountId, "default"),
  );
  // Removal must not be what creates the store. A host that never queued an inbound
  // event has nothing to discard, and the creating opener would migrate a fresh
  // database just to delete zero rows - the same reason the listing sibling above
  // takes the non-creating path.
  const env = params.stateDir ? createStateDirEnv(params.stateDir) : process.env;
  if (!existsSync(resolveDatabasePath({ env }))) {
    return { discarded: 0, undelivered: 0, recoverable: 0 };
  }
  const database = openChannelIngressDatabase(params.stateDir);
  return runOpenClawStateWriteTransaction(
    (tx) => {
      const kysely = getChannelIngressKysely(tx.db);
      const countByStatus = (statuses: ["pending", "claimed"] | ["failed"]): number =>
        executeSqliteQueryTakeFirstSync(
          tx.db,
          kysely
            .selectFrom("channel_ingress_events")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("queue_name", "=", queueName)
            .where("status", "in", statuses),
        )?.count ?? 0;
      const undelivered = countByStatus(["pending", "claimed"]);
      // Dead letters are work too: `channels dead-letters resubmit` can replay them until
      // this deletion drops them, so reporting them only as part of `discarded` would
      // describe recoverable inbound events as routine cleanup.
      const recoverable = countByStatus(["failed"]);
      const discarded = affectedRows(
        executeSqliteQuerySync(
          tx.db,
          kysely.deleteFrom("channel_ingress_events").where("queue_name", "=", queueName),
        ),
      );
      return { discarded, undelivered, recoverable };
    },
    { path: database.path },
  );
}
