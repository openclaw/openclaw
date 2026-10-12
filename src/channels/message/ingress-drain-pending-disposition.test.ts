import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";

describe("channel ingress pending disposition", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("settles policy rows before the candidate window binds them", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("stale", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "current",
        { text: "current work" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      const adopted: string[] = [];
      // scanLimit 1 proves the stale row never occupies the candidate window:
      // without the disposition pass it would bind the lane and block "current".
      const drain = createChannelIngressDrain({
        queue,
        scanLimit: 1,
        startLimit: 1,
        now: () => 10,
        resolvePendingDisposition: (record) =>
          record.id === "stale"
            ? { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" }
            : null,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["current"]);
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "stale", reason: "stale-ambient-backlog" },
      ]);
      drain.dispose();
    });
  });

  it("keeps every pending row claimable when a channel provides no policy", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "channel-owned work" }, { receivedAt: 0 });
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => Number.MAX_SAFE_INTEGER,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["old"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it("keeps a row claimable when the policy declines it", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("unreadable", { text: "malformed" }, { receivedAt: 0 });
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        // Mirrors a channel codec that cannot read the stored bytes.
        resolvePendingDisposition: () => null,
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["unreadable"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it("fences a lost disposition compare-and-set without blocking unrelated lanes", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("raced", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "same-lane",
        { text: "later ambient" },
        {
          laneKey: "lane:a",
          receivedAt: 1,
        },
      );
      await queue.enqueue(
        "other-lane",
        { text: "independent" },
        { laneKey: "lane:b", receivedAt: 2 },
      );
      const fail = queue.fail.bind(queue);
      // A concurrent claimer already owns "raced", so its fail() finds no pending row.
      const failSpy = vi.fn(async (...args: Parameters<typeof queue.fail>) =>
        args[0] === "raced" ? false : await fail(...args),
      );
      queue.fail = failSpy;
      const resolved: string[] = [];
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        // Both lane:a rows are disposition-eligible; the head loses its CAS.
        resolvePendingDisposition: (record) => {
          resolved.push(record.id);
          return record.id === "other-lane"
            ? null
            : { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" };
        },
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      // The fenced lane stops all further disposition work for this snapshot.
      expect(resolved).toEqual(["raced", "other-lane"]);
      expect(failSpy.mock.calls.map((call) => call[0])).toEqual(["raced"]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "raced",
        "same-lane",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it("never fails a generation resubmitted while the policy was still deciding", async () => {
    await withTempState(async (stateDir) => {
      let clock = 10;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("raced", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "same-lane",
        { text: "later ambient" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      await queue.enqueue(
        "other-lane",
        { text: "independent" },
        { laneKey: "lane:b", receivedAt: 2 },
      );
      const policyEntered = createDeferredCore();
      const policyRelease = createDeferredCore();
      const logs: string[] = [];
      const adopted: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => 50,
        onLog: (message) => logs.push(message),
        resolvePendingDisposition: async (record) => {
          if (record.id !== "raced") {
            return null;
          }
          policyEntered.resolve();
          await policyRelease.promise;
          return { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" };
        },
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      const pass = drain.drainOnce();
      await policyEntered.promise;
      // While the policy is still deciding, another owner claims and fails the
      // very row it inspected, and an operator resubmits it as fresh work.
      clock = 20;
      const claim = await queue.claim("raced", { ownerId: "other-owner" });
      expect(claim).not.toBeNull();
      if (!claim) {
        return;
      }
      expect(await queue.fail(claim, { reason: "poison" })).toBe(true);
      clock = 30;
      await expect(queue.resubmit?.("raced")).resolves.toMatchObject({ kind: "resubmitted" });

      policyRelease.resolve();
      expect(await pass).toEqual({ started: 1 });
      await drain.waitForIdle();

      // The stale decision loses to the resubmitted generation: the row is
      // still pending, its lane is fenced for the pass, other lanes proceed.
      expect(adopted).toEqual(["other-lane"]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "same-lane",
        "raced",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(logs).toContain("ingress drain: pending disposition lost race for event raced");
      drain.dispose();
    });
  });

  it("never fails a generation resubmitted within the same clock tick", async () => {
    await withTempState(async (stateDir) => {
      // Frozen clock: every transition below shares one `now`, so only a
      // monotonic generation can tell the resubmitted row from the inspected one.
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });
      await queue.enqueue("raced", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 10 });
      const policyEntered = createDeferredCore();
      const policyRelease = createDeferredCore();
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        resolvePendingDisposition: async () => {
          policyEntered.resolve();
          await policyRelease.promise;
          return { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" };
        },
        dispatchClaimedEvent: async (_claim, lifecycle) => {
          await lifecycle.onAdopted();
        },
      });

      const pass = drain.drainOnce();
      await policyEntered.promise;
      const claim = await queue.claim("raced", { ownerId: "other-owner" });
      expect(claim).not.toBeNull();
      if (!claim) {
        return;
      }
      expect(await queue.fail(claim, { reason: "poison", failedAt: 10 })).toBe(true);
      await expect(queue.resubmit?.("raced", { resubmittedAt: 10 })).resolves.toMatchObject({
        kind: "resubmitted",
        record: { receivedAt: 10, attempts: 0 },
      });

      policyRelease.resolve();
      expect(await pass).toEqual({ started: 0 });
      await drain.waitForIdle();
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual(["raced"]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it("holds a deferred row and its lane without failing or claiming it", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue(
        "hydrating",
        { text: "unclassifiable" },
        {
          laneKey: "lane:a",
          receivedAt: 0,
        },
      );
      await queue.enqueue(
        "same-lane",
        { text: "behind it" },
        {
          laneKey: "lane:a",
          receivedAt: 1,
        },
      );
      await queue.enqueue(
        "other-lane",
        { text: "independent" },
        {
          laneKey: "lane:b",
          receivedAt: 2,
        },
      );
      const resolved: string[] = [];
      const adopted: string[] = [];
      let hydrated = false;
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        resolvePendingDisposition: (record) => {
          resolved.push(record.id);
          if (record.id === "other-lane") {
            return null;
          }
          return hydrated
            ? { kind: "fail", reason: "stale-ambient-backlog", message: "stale ambient row" }
            : { kind: "defer" };
        },
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      expect(resolved).toEqual(["hydrating", "other-lane"]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "hydrating",
        "same-lane",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);

      // Once the channel can classify the row, the next pass settles it.
      hydrated = true;
      expect(await drain.drainOnce()).toEqual({ started: 0 });
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      expect((await queue.listFailed?.({ limit: "all" }))?.map((row) => row.id)).toEqual([
        "hydrating",
        "same-lane",
      ]);
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      drain.dispose();
    });
  });

  it.each(["defer", "lost-cas", "none"] as const)(
    "keeps a disposition-held row from superseding active work (%s)",
    async (mode) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("old", { text: "old" }, { laneKey: "shared" });
        const fail = queue.fail.bind(queue);
        queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) =>
          args[0] === "new" ? false : await fail(...args),
        );
        let oldSignal: AbortSignal | undefined;
        const drain = createChannelIngressDrain({
          queue,
          now: () => 10,
          shouldSupersedePending: (candidate) => candidate.id === "new",
          resolvePendingDisposition: (record) =>
            record.id !== "new" || mode === "none"
              ? null
              : mode === "defer"
                ? { kind: "defer" }
                : { kind: "fail", reason: "stale-ambient-backlog", message: "stale row" },
          dispatchClaimedEvent: async (claim, lifecycle) => {
            if (claim.id === "old") {
              oldSignal = lifecycle.abortSignal;
              return { kind: "deferred" };
            }
            await lifecycle.onAdopted();
            return { kind: "completed" };
          },
        });
        try {
          await drain.drainOnce();
          await queue.enqueue("new", { text: "new" }, { laneKey: "shared" });
          const held = mode !== "none";
          // A row the hook holds (or whose fail lost its CAS) can neither cancel
          // the pre-adoption owner nor start in the same pass; the control does.
          expect(await drain.drainOnce()).toEqual({ started: held ? 0 : 1 });
          await drain.waitForIdle();
          expect(oldSignal?.aborted).toBe(!held);
          expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual(
            held ? ["new"] : [],
          );
          expect((await queue.listClaims()).map((claim) => claim.id)).toEqual(held ? ["old"] : []);
        } finally {
          drain.dispose();
        }
      });
    },
  );

  it.each([true, false])(
    "commits a fail only while its verdict is still valid at the write (edited=%s)",
    async (edited) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        await queue.enqueue("row", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
        let valid = true;
        const fail = queue.fail.bind(queue);
        // The policy's inputs change after the resolver returned its verdict but
        // before the drain writes it (a config publish in that gap).
        queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) => {
          if (edited) {
            valid = false;
          }
          return await fail(...args);
        });
        const drain = createChannelIngressDrain({
          queue,
          now: () => 10,
          resolvePendingDisposition: () => ({
            kind: "fail",
            reason: "stale-ambient-backlog",
            message: "stale ambient row",
            isStillValid: () => valid,
          }),
          dispatchClaimedEvent: async (_claim, lifecycle) => {
            await lifecycle.onAdopted();
          },
        });
        try {
          expect(await drain.drainOnce()).toEqual({ started: 0 });
          expect((await queue.listFailed?.({ limit: "all" }))?.map((row) => row.id)).toEqual(
            edited ? [] : ["row"],
          );
          // An invalidated verdict leaves the row claimable for the next pass.
          expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual(
            edited ? ["row"] : [],
          );
        } finally {
          drain.dispose();
        }
      });
    },
  );
});
