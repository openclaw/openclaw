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
  const observe = (
    id: string | ChannelIngressQueueClaimRef,
    result: Promise<boolean>,
    restore: () => void,
  ) => {
    if (eventId === undefined || (typeof id === "string" ? id : id.id) === eventId) {
      restore();
      committed.resolve(result);
    }
    return result;
  };
  switch (method) {
    case "complete": {
      const write = queue.complete;
      queue.complete = (...args) =>
        observe(args[0], write.apply(queue, args), () => {
          queue.complete = write;
        });
      break;
    }
    case "release": {
      const write = queue.release;
      queue.release = (...args) =>
        observe(args[0], write.apply(queue, args), () => {
          queue.release = write;
        });
      break;
    }
    case "fail": {
      const write = queue.fail;
      queue.fail = (...args) =>
        observe(args[0], write.apply(queue, args), () => {
          queue.fail = write;
        });
      break;
    }
  }
  return committed.promise;
}

export function createTestIngressQueue(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
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
        lane_key: null,
        payload_json: JSON.stringify({ text: `msg-${index}` }),
        metadata_json: null,
        completed_metadata_json: null,
        received_at: index,
        updated_at: index,
        attempts: 0,
        claim_token: null,
        claim_owner: null,
        claimed_at: null,
        completed_at: null,
      });
    }
    executeSqliteQuerySync(database.db, kysely.insertInto("channel_ingress_events").values(rows));
  }
}
