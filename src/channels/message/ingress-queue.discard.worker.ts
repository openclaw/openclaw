import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { ChannelIngressFailedEventIdentity } from "./ingress-queue.types.js";

/** The worker transaction compares the exact failures confirmed by the operator. */
export function deleteChannelIngressFailedEventsInDatabase(
  db: EngineConnection,
  input: { queueName: string; failures: ChannelIngressFailedEventIdentity[] },
): number {
  let deleted = 0;
  // Bound statement parameters and expression depth while retaining one worker transaction.
  for (let offset = 0; offset < input.failures.length; offset += 100) {
    const failures = input.failures.slice(offset, offset + 100);
    deleted += Number(
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "channel_ingress_events">>(db)
          .deleteFrom("channel_ingress_events")
          .where("queue_name", "=", input.queueName)
          .where("status", "=", "failed")
          .where((eb) =>
            eb.or(
              failures.map((failure) =>
                eb.and([
                  eb("event_id", "=", failure.id),
                  eb("updated_at", "=", failure.updatedAt),
                  eb("received_at", "=", failure.receivedAt),
                  eb("attempts", "=", failure.attempts),
                ]),
              ),
            ),
          ),
      ).numAffectedRows ?? 0n,
    );
  }
  return deleted;
}
