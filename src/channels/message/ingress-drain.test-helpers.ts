import type { Insertable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

export type IngressDrainTestPayload = { text: string };

/** Observe the real commit, not just invocation of a queue write. */
export function observeChannelIngressQueueWrite<
  TMethod extends "complete" | "release" | "fail",
  TArgs extends [string | { id: string }, ...unknown[]],
>(
  queue: Record<TMethod, (...args: TArgs) => Promise<boolean>>,
  method: TMethod,
  eventId?: string,
): Promise<boolean> {
  const committed = createDeferredCore<boolean>();
  const write = queue[method];
  queue[method] = (...args) => {
    const result = write.apply(queue, args);
    if (eventId === undefined || (typeof args[0] === "string" ? args[0] : args[0].id) === eventId) {
      queue[method] = write;
      committed.resolve(result);
    }
    return result;
  };
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
