import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";

describe("channel ingress pending disposition", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("settles stale policy rows before the existing candidate window", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("stale", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "current",
        { text: "current work" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      const adopted: string[] = [];
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

  it("keeps pending rows claimable when a channel does not provide policy", async () => {
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

  it.each([
    {
      name: "policy evaluation",
      expectedLog:
        "ingress drain: pending disposition policy failed for event broken on lane:a: policy unavailable",
      rejects: true,
    },
    {
      name: "dead-letter write",
      expectedLog:
        "ingress drain: pending disposition write failed for event broken on lane:a: storage unavailable",
      rejects: true,
    },
    {
      name: "false-return CAS loss",
      expectedLog: "ingress drain: pending disposition lost race for event broken",
      rejects: false,
    },
  ])("contains a $name failure to its lane", async ({ name, expectedLog, rejects }) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("broken", { text: "old ambient" }, { laneKey: "lane:a", receivedAt: 0 });
      await queue.enqueue(
        "same-lane",
        { text: "later work" },
        { laneKey: "lane:a", receivedAt: 1 },
      );
      await queue.enqueue(
        "other-lane",
        { text: "independent" },
        { laneKey: "lane:b", receivedAt: 2 },
      );
      const fail = queue.fail.bind(queue);
      const failAttempts: string[] = [];
      queue.fail = vi.fn(async (...args: Parameters<typeof queue.fail>) => {
        const id = typeof args[0] === "string" ? args[0] : args[0].id;
        failAttempts.push(id);
        if (id === "broken") {
          if (name === "dead-letter write") {
            throw new Error("storage unavailable");
          }
          if (name === "false-return CAS loss") {
            return false;
          }
        }
        return await fail(...args);
      });
      const adopted: string[] = [];
      const logs: string[] = [];
      const resolved: string[] = [];
      const drain = createChannelIngressDrain({
        queue,
        now: () => 10,
        onLog: (message) => logs.push(message),
        resolvePendingDisposition: (record) => {
          resolved.push(record.id);
          if (name === "policy evaluation") {
            if (record.id === "broken") {
              throw new Error("policy unavailable");
            }
          }
          if (record.id === "other-lane") {
            return null;
          }
          return {
            kind: "fail",
            reason: "stale-ambient-backlog",
            message: "stale ambient row",
          };
        },
        dispatchClaimedEvent: async (claim, lifecycle) => {
          adopted.push(claim.id);
          await lifecycle.onAdopted();
        },
      });

      if (rejects) {
        await expect(drain.drainOnce()).rejects.toThrow(
          "ingress drain: 1 pending disposition failure(s)",
        );
      } else {
        await expect(drain.drainOnce()).resolves.toEqual({ started: 1 });
      }
      await drain.waitForIdle();
      expect(adopted).toEqual(["other-lane"]);
      expect((await queue.listPending({ limit: "all" })).map((row) => row.id)).toEqual([
        "broken",
        "same-lane",
      ]);
      expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      expect(resolved).toEqual(["broken", "other-lane"]);
      expect(failAttempts).toEqual(name === "policy evaluation" ? [] : ["broken"]);
      expect(logs).toContain(expectedLog);
      drain.dispose();
    });
  });
});
