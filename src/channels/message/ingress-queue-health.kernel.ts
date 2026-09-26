import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type { ChannelIngressFailedHealth } from "./ingress-queue-read-contract.js";

/** Count failed channel ingress events per channel account for operator health surfaces. */
export function countFailedChannelIngressQueueEntriesInDatabase(
  db: DatabaseSync,
): ChannelIngressFailedHealth[] {
  const queueDb =
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">>(db);
  const rows = executeSqliteQuerySync(
    db,
    queueDb
      .selectFrom("channel_ingress_events")
      .select((eb) => [
        "channel_id as channelId",
        "account_id as accountId",
        eb.fn.countAll<number>().as("count"),
        eb.fn.min<number>("failed_at").as("oldestFailedAt"),
      ])
      .where("status", "=", "failed")
      .groupBy(["channel_id", "account_id"])
      .orderBy("channel_id", "asc")
      .orderBy("account_id", "asc"),
  ).rows;
  return rows.map(({ oldestFailedAt, ...row }) =>
    oldestFailedAt == null ? row : Object.assign(row, { oldestFailedAt }),
  );
}
