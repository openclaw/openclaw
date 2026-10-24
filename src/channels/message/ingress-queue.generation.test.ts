import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type ChannelIngressTestDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;

function createTestIngressQueue<TPayload>(
  stateDir: string,
  options: Omit<
    Parameters<typeof createChannelIngressQueue>[0],
    "channelId" | "accountId" | "stateDir"
  > = {},
) {
  return createChannelIngressQueue<TPayload>({
    channelId: "test",
    accountId: "account",
    stateDir,
    ...options,
  });
}

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-queue-generation-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

function openIngressStateDatabase(stateDir: string) {
  return openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
}

// Row generations: every transition moves updated_at strictly forward, and a
// generation-fenced fail commits only against the generation it inspected.
describe("channel ingress queue row generations", () => {
  it("moves updatedAt strictly forward on every transition under a frozen clock", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir, { now: () => 10 });
      const { db } = openIngressStateDatabase(stateDir);
      const storedUpdatedAt = () =>
        expectDefined(
          executeSqliteQueryTakeFirstSync(
            db,
            getNodeSqliteKysely<ChannelIngressTestDatabase>(db)
              .selectFrom("channel_ingress_events")
              .select(["updated_at"])
              .where("event_id", "=", "row"),
          ),
          "stored row",
        ).updated_at;
      const claim = async () => expectDefined(await queue.claim("row", { ownerId: "w" }), "claim");

      await queue.enqueue("row", { text: "first" }, { receivedAt: 10 });
      expect(storedUpdatedAt()).toBe(10);
      let held = await claim();
      expect(storedUpdatedAt()).toBe(11);
      expect(await queue.refreshClaim?.(held, { refreshedAt: 10 })).toBe(true);
      expect(storedUpdatedAt()).toBe(12);
      expect(await queue.release(held, { recordAttempt: false, releasedAt: 10 })).toBe(true);
      expect(storedUpdatedAt()).toBe(13);
      // Readers see the same generation the next write will move past.
      expect((await queue.listPending({ limit: "all" }))[0]?.updatedAt).toBe(13);
      held = await claim();
      expect(storedUpdatedAt()).toBe(14);
      expect(await queue.fail(held, { reason: "poison", failedAt: 10 })).toBe(true);
      expect(storedUpdatedAt()).toBe(15);
      await expect(queue.resubmit?.("row", { resubmittedAt: 10 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { updatedAt: 16 },
      });
      held = await claim();
      expect(storedUpdatedAt()).toBe(17);
      expect(await queue.complete(held, { completedAt: 10 })).toBe(true);
      expect(storedUpdatedAt()).toBe(18);
    });
  });

  it("fails only the pending generation the caller inspected", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10;
      const queue = createTestIngressQueue<{ text: string }>(stateDir, { now: () => clock });
      await queue.enqueue("row", { text: "first" }, { receivedAt: 0 });
      const inspected = expectDefined(
        (await queue.listPending({ limit: "all" }))[0],
        "inspected pending row",
      );
      const generation = { updatedAt: inspected.updatedAt };

      // Another owner claims and fails the inspected generation; an operator
      // resubmits the same id as fresh pending work.
      clock = 20;
      const claim = await queue.claim("row", { ownerId: "other-owner" });
      expect(claim).not.toBeNull();
      if (!claim) {
        return;
      }
      expect(await queue.fail(claim, { reason: "poison" })).toBe(true);
      clock = 30;
      await expect(queue.resubmit?.("row")).resolves.toMatchObject({ kind: "resubmitted" });

      // A fail fenced to the inspected generation is a no-op on its successor.
      expect(await queue.fail("row", { reason: "stale", generation })).toBe(false);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual(["row"]);

      // The successor still fails under its own facts.
      const fresh = expectDefined(
        (await queue.listPending({ limit: "all" }))[0],
        "resubmitted pending row",
      );
      expect(await queue.fail("row", { reason: "stale", generation: fresh })).toBe(true);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "row", reason: "stale" },
      ]);
    });
  });

  it("refuses a fail whose caller guard turns false by its commit", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue<{ text: string }>(stateDir);
      await queue.enqueue("kept", { text: "kept" });
      await queue.enqueue("failed", { text: "failed" });
      const checks: boolean[] = [];
      // Current when the write transaction opens, stale by the commit grant.
      const guard = () => {
        checks.push(checks.length === 0);
        return checks.at(-1)!;
      };

      expect(await queue.fail("kept", { reason: "policy", isCurrent: guard })).toBe(false);
      expect(checks).toEqual([true, false]);
      expect(await queue.fail("failed", { reason: "policy", isCurrent: () => true })).toBe(true);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual(["kept"]);
      expect((await queue.listFailed?.({ limit: "all" }))?.map((row) => row.id)).toEqual([
        "failed",
      ]);
    });
  });
});
