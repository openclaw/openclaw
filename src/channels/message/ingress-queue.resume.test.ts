import { describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  CHANNEL_INGRESS_CLAIM_SCAN_PAGE_BUDGET,
  CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT,
} from "./ingress-queue.codec.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

function createTestIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>({
    channelId: "test",
    accountId: "account",
    stateDir,
    ...options,
  });
}

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-queue-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

function openIngressStateDatabase(stateDir: string) {
  return openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
}

function insertPendingIngressRows(
  stateDir: string,
  rows: Array<{ eventId: string; receivedAt: number; laneKey: string | null; lane: string }>,
) {
  const { db } = openIngressStateDatabase(stateDir);
  const kysely = getNodeSqliteKysely<ChannelIngressTestDatabase>(db);
  // Batch below SQLite's per-statement bind limit while keeping the insert fast.
  for (let offset = 0; offset < rows.length; offset += 500) {
    executeSqliteQuerySync(
      db,
      kysely.insertInto("channel_ingress_events").values(
        rows.slice(offset, offset + 500).map((row) => ({
          queue_name: '["test","account"]',
          event_id: row.eventId,
          channel_id: "test",
          account_id: "account",
          status: "pending",
          lane_key: row.laneKey,
          payload_json: JSON.stringify({ lane: row.lane }),
          metadata_json: null,
          received_at: row.receivedAt,
          updated_at: row.receivedAt,
          attempts: 0,
        })),
      ),
    );
  }
}

describe("channel ingress queue resume", () => {
  const scanLimit = 100;
  const blockedPrefixRows =
    (CHANNEL_INGRESS_CLAIM_SCAN_PAGE_BUDGET + 1) *
    (scanLimit + CHANNEL_INGRESS_CORRUPT_REPAIR_LIMIT);

  it.each([
    {
      name: "resumes past a blocked prefix larger than the page budget (derived lanes)",
      // Rows lack stored lane_key; deriveLaneKey assigns the blocked lane, so the
      // SQL filter cannot help and the bounded keyset paging must page forward.
      laneKeyByRow: undefined,
      reconcileStoredLaneKey: undefined,
    },
    {
      name: "resumes past a blocked prefix larger than the page budget (stored lanes, reconcile)",
      // Reconcile keeps stored-lane rows visible to the JS pass, so paging must
      // walk past a prefix of stored blocked lanes beyond the budget.
      laneKeyByRow: (row: number) => (row < blockedPrefixRows ? "blocked" : "free"),
      reconcileStoredLaneKey: true,
    },
  ] as const)("$name", async ({ laneKeyByRow, reconcileStoredLaneKey }) => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      // One bounded claim pass scans (budget + 1) snapshots of scanLimit + repair
      // rows, so this blocked prefix exhausts the budget before the free row.
      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows + 1 }, (_, row) => ({
          eventId: row < blockedPrefixRows ? `blocked-${row}` : "free",
          receivedAt: row,
          laneKey: laneKeyByRow?.(row) ?? null,
          lane: row < blockedPrefixRows ? "blocked" : "free",
        })),
      );

      const deriveLaneKey = (record: { payload: { lane: string } }) => record.payload.lane;

      const claimOptions = {
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey,
        ...(reconcileStoredLaneKey ? { reconcileStoredLaneKey: () => true } : {}),
      };

      // The bounded pass cannot reach the free row in one call, but it must
      // retain its scan position so the next direct call resumes past the prefix.
      await expect(queue.claimNext(claimOptions)).resolves.toBeNull();

      const claimed = await queue.claimNext(claimOptions);
      expect(claimed?.id).toBe("free");
    });
  });
});
