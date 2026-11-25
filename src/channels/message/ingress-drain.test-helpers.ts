import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  createChannelIngressQueue,
  type ChannelIngressQueue,
  type ChannelIngressQueueClaimRef,
} from "./ingress-queue.js";

export type IngressDrainTestPayload = { text: string };
type QueueOptions = Parameters<typeof createChannelIngressQueue>[0];

/** Observe the real commit, not just invocation of a queue write. */
export function observeChannelIngressQueueWrite<TCompletedMetadata>(
  queue: Pick<
    ChannelIngressQueue<unknown, unknown, TCompletedMetadata>,
    "complete" | "release" | "fail"
  >,
  method: "complete" | "release" | "fail",
  eventId?: string,
): Promise<boolean> {
  const committed = createDeferredCore<boolean>();
  const observe = <TArgs extends [string | ChannelIngressQueueClaimRef, ...unknown[]]>(
    write: (...args: TArgs) => Promise<boolean>,
    restore: (write: (...args: TArgs) => Promise<boolean>) => void,
  ) => {
    return (...args: TArgs) => {
      const result = write.apply(queue, args);
      const [id] = args;
      if (eventId === undefined || (typeof id === "string" ? id : id.id) === eventId) {
        restore(write);
        committed.resolve(result);
      }
      return result;
    };
  };
  switch (method) {
    case "complete":
      queue.complete = observe(queue.complete, (write) => {
        queue.complete = write;
      });
      break;
    case "release":
      queue.release = observe(queue.release, (write) => {
        queue.release = write;
      });
      break;
    case "fail":
      queue.fail = observe(queue.fail, (write) => {
        queue.fail = write;
      });
      break;
  }
  return committed.promise;
}

export function createTestIngressQueue(
  stateDir: string,
  options: Omit<QueueOptions, "channelId" | "accountId" | "stateDir"> = {},
) {
  return createChannelIngressQueue<IngressDrainTestPayload>({
    channelId: "test",
    accountId: "a",
    stateDir,
    now: () => Date.now(),
    ...options,
  });
}

export async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-drain-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

export function seedPendingBacklog(stateDir: string, total: number): void {
  const database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">>(
    database.db,
  );
  for (let offset = 0; offset < total; offset += 500) {
    const rows: Array<Insertable<OpenClawStateKyselyDatabase["channel_ingress_events"]>> = [];
    const end = Math.min(offset + 500, total);
    for (let index = offset; index < end; index += 1) {
      rows.push({
        queue_name: JSON.stringify(["test", "a"]),
        event_id: `evt-${index}`,
        channel_id: "test",
        account_id: "a",
        status: "pending",
        payload_json: JSON.stringify({ text: `msg-${index}` }),
        received_at: index,
        updated_at: index,
      });
    }
    executeSqliteQuerySync(database.db, kysely.insertInto("channel_ingress_events").values(rows));
  }
}
