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

  it("invalidates the resume cursor when the lane-policy callbacks change", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      // row-0 carries no stored lane key. Under the first policy both row-0 and
      // the blocked prefix derive to "blocked", so the first direct call exhausts
      // the page budget and saves a resume cursor past the prefix. The second call
      // uses a changed policy that makes row-0 (before the saved cursor) eligible;
      // the cursor must be invalidated or row-0 would be skipped.
      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows + 1 }, (_, row) => ({
          eventId: row === 0 ? "row-0" : row < blockedPrefixRows ? `blocked-${row}` : "free",
          receivedAt: row,
          laneKey: null,
          lane: row === 0 || row >= blockedPrefixRows ? "free" : "blocked",
        })),
      );

      // First policy treats row-0 as blocked too, so the bounded pass spends its
      // whole budget on the blocked prefix and returns null with a retained cursor.
      const firstPolicy = () => "blocked";
      await expect(
        queue.claimNext({
          ownerId: "worker",
          blockedLaneKeys: ["blocked"],
          scanLimit,
          deriveLaneKey: firstPolicy,
        }),
      ).resolves.toBeNull();

      // Changed policy now derives row-0 to "free". The retained cursor must be
      // invalidated (policy changed), so the next call rescans from the front and
      // claims row-0 instead of skipping past it to the tail free row.
      const changedPolicy = (record: { payload: { lane: string } }) => record.payload.lane;
      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey: changedPolicy,
      });
      expect(claimed?.id).toBe("row-0");
    });
  });

  it("invalidates the resume cursor when an earlier row is enqueued between direct claims", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      // A blocked prefix larger than the page budget fills the first bounded pass,
      // which retains a resume cursor past the prefix and returns null. Then a new
      // free-lane row is enqueued with receivedAt BEFORE the cursor. The retained
      // cursor must be invalidated, or the keyset predicate (received_at > cursor)
      // would skip the earlier row and claim the tail free row first.
      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows + 1 }, (_, row) => ({
          eventId: row < blockedPrefixRows ? `blocked-${row}` : "free-tail",
          receivedAt: row,
          laneKey: null,
          lane: row < blockedPrefixRows ? "blocked" : "free",
        })),
      );

      const deriveLaneKey = (record: { payload: { lane: string } }) => record.payload.lane;
      const claimOptions = {
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey,
      };

      // First call exhausts the budget over the blocked prefix and retains a cursor.
      await expect(queue.claimNext(claimOptions)).resolves.toBeNull();

      // Enqueue an earlier free-lane row before the saved cursor position. This
      // write must invalidate the resume cursor.
      await queue.enqueue("earlier-free", { lane: "free" }, { receivedAt: -1 });

      // The next direct call must rescan from the front and claim the earlier row.
      const claimed = await queue.claimNext(claimOptions);
      expect(claimed?.id).toBe("earlier-free");
    });
  });

  it("revalidates the resume cursor against authoritative state when another handle enqueues an earlier row", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });
      const other = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows + 1 }, (_, row) => ({
          eventId: row < blockedPrefixRows ? `blocked-${row}` : "free-tail",
          receivedAt: row,
          laneKey: null,
          lane: row < blockedPrefixRows ? "blocked" : "free",
        })),
      );

      const deriveLaneKey = (record: { payload: { lane: string } }) => record.payload.lane;
      const claimOptions = {
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey,
      };

      // First call exhausts the budget over the blocked prefix and retains a cursor.
      await expect(queue.claimNext(claimOptions)).resolves.toBeNull();

      // A second queue handle writes an earlier free-lane row. The first handle's
      // closure invalidation cannot observe this write, so the resume cursor must
      // be revalidated against the authoritative queue state on the next call.
      await other.enqueue("earlier-free", { lane: "free" }, { receivedAt: -1 });

      const claimed = await queue.claimNext(claimOptions);
      expect(claimed?.id).toBe("earlier-free");
    });
  });

  it("revalidates the resume cursor when a minimal claim reference releases an earlier row", async () => {
    await withTempState(async (stateDir) => {
      let clock = 1;
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => clock++ });

      insertPendingIngressRows(stateDir, [
        { eventId: "before-prefix", receivedAt: -1, laneKey: null, lane: "free" },
      ]);
      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows + 1 }, (_, row) => ({
          eventId: row < blockedPrefixRows ? `blocked-${row}` : "free-tail",
          receivedAt: row,
          laneKey: null,
          lane: row < blockedPrefixRows ? "blocked" : "free",
        })),
      );

      const deriveLaneKey = (record: { payload: { lane: string } }) => record.payload.lane;
      const claimOptions = {
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey,
      };

      const claim = await queue.claim("before-prefix");
      expect(claim?.id).toBe("before-prefix");

      // First direct call exhausts the budget over the blocked prefix and retains
      // a resume cursor; the claimed row is not pending so it is not scanned.
      await expect(queue.claimNext(claimOptions)).resolves.toBeNull();

      // Release through the minimal reference (no receivedAt), so the closure guard
      // cannot invalidate the retained cursor. The authoritative queue revalidation
      // on the next direct call must still drop it.
      await queue.release({ id: "before-prefix", claim: { token: claim!.claim.token } });

      const claimed = await queue.claimNext(claimOptions);
      expect(claimed?.id).toBe("before-prefix");
    });
  });

  it("revalidates the in-flight page cursor when another handle writes during paging", async () => {
    await withTempState(async (stateDir) => {
      let clock = 0;
      let injected: Promise<unknown> | undefined;
      let queued = false;
      const other = createTestIngressQueue<{ lane: string }>(stateDir, { now: () => 1_000 });
      const queue = createTestIngressQueue<{ lane: string }>(stateDir, {
        now: () => {
          const tick = clock++;
          if (tick >= 1 && !queued) {
            queued = true;
            // Lands a free-lane row before the page cursor while the first direct
            // call is paging; the in-flight revalidation must drop the keyset and
            // claim the earlier row instead of skipping it.
            injected = other.enqueue("paging-earlier", { lane: "free" }, { receivedAt: -100 });
          }
          return tick;
        },
      });

      insertPendingIngressRows(
        stateDir,
        Array.from({ length: blockedPrefixRows }, (_, row) => ({
          eventId: `blocked-${row}`,
          receivedAt: row,
          laneKey: null,
          lane: "blocked",
        })),
      );

      const deriveLaneKey = (record: { payload: { lane: string } }) => record.payload.lane;
      const claimed = await queue.claimNext({
        ownerId: "worker",
        blockedLaneKeys: ["blocked"],
        scanLimit,
        deriveLaneKey,
      });
      await injected;
      expect(claimed?.id).toBe("paging-earlier");
    });
  });
});
