import { afterAll, describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { countChannelIngressQueueHealth } from "./ingress-queue-health.js";
import { createChannelIngressQueue } from "./ingress-queue.js";
import { createTestIngressQueue, useRetainedIngressState } from "./ingress-queue.test-helpers.js";

const withTempState = useRetainedIngressState(afterAll);
async function withIsolatedState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  return withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-discard-", applyEnv: false },
    ({ stateDir }) => fn(stateDir),
  );
}

describe("channel ingress operator discard", () => {
  it("discards failures in the worker and refreshes cached health", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("discard", {});
      await queue.fail("discard", { reason: "rejected" });
      const failures = await queue.listFailed!();
      const context = captureOpenClawStateWorkerContext({ env: { OPENCLAW_STATE_DIR: stateDir } });
      expect((await countChannelIngressQueueHealth(stateDir, context)).failed).toEqual([
        expect.objectContaining({ channelId: "test", accountId: "account", count: 1 }),
      ]);
      const hostQuery = vi.spyOn(sqliteQueries, "executeSqliteQuerySync").mockImplementation(() => {
        throw new Error("Ingress deletion must not query SQLite on the calling thread");
      });
      try {
        expect(await queue.deleteFailed(failures)).toBe(1);
      } finally {
        hostQuery.mockRestore();
      }
      expect((await countChannelIngressQueueHealth(stateDir, context)).failed).toEqual([]);
      expect(await queue.enqueue("discard", {})).toMatchObject({ kind: "accepted" });
    });
  });

  it.each(["transaction", "commit"] as const)(
    "preserves confirmed failures when queue authority expires at %s admission",
    async (stage) => {
      await withIsolatedState(async (stateDir) => {
        let current = true;
        const queue = createChannelIngressQueue({ channelId: "test", stateDir }, () => {
          if (!current) {
            throw new Error("queue retired");
          }
        });
        await queue.enqueue("retained", {});
        await queue.fail("retained", { reason: "rejected" });
        const failures = await queue.listFailed!();
        let reached = false;
        const admission = probe.admission(workerAdmission, (request, grant, admit) => {
          if (request.stage === stage) {
            reached = true;
            current = false;
          }
          admit(request, grant);
        });
        try {
          await expect(queue.deleteFailed(failures)).rejects.toThrow("queue retired");
          expect(reached).toBe(true);
        } finally {
          admission.mockRestore();
        }
        const reader = createChannelIngressQueue({ channelId: "test", stateDir });
        expect(await reader.listFailed!()).toEqual(failures);
      });
    },
  );

  it("preserves a newer failure that replaced the operator snapshot", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });
      await queue.enqueue("event-1", { text: "first attempt" }, { receivedAt: 10 });
      const firstClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!firstClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(firstClaim, { reason: "first-failure", failedAt: 20 });
      const [selected] = (await queue.listFailed?.({ limit: "all" })) ?? [];
      if (!selected || !queue.resubmit) {
        throw new Error("Expected a selected, resubmittable failure");
      }

      await queue.resubmit("event-1", { resubmittedAt: 30 });
      const secondClaim = await queue.claim("event-1", { ownerId: "worker" });
      if (!secondClaim) {
        throw new Error("Expected a resubmitted claim");
      }
      await queue.fail(secondClaim, { reason: "second-failure", failedAt: 40 });

      await expect(queue.deleteFailed([selected])).resolves.toBe(0);
      await expect(queue.listFailed?.({ limit: "all" })).resolves.toEqual([
        expect.objectContaining({ id: "event-1", reason: "second-failure", failedAt: 40 }),
      ]);
    });
  });

  it("deletes a selection larger than SQLite's binding limit", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
        stateDir,
      });
      await queue.enqueue("event-1", { text: "discard" }, { receivedAt: 10 });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const [selected] = (await queue.listFailed?.({ limit: "all" })) ?? [];
      if (!selected) {
        throw new Error("Expected a selected failure");
      }
      const oversizedSelection = Array.from({ length: 40_000 }, (_, index) => ({
        ...selected,
        id: `missing-${index}`,
      }));
      oversizedSelection.push(selected);

      await expect(queue.deleteFailed(oversizedSelection)).resolves.toBe(1);
      await expect(queue.listFailed?.({ limit: "all" })).resolves.toEqual([]);
    });
  });
});
