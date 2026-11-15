import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain supersede", () => {
  it.each([true, false])("checks prepared policy at cancellation (current=%s)", async (current) => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("old", { text: "old" }, { laneKey: "shared" });
      const guard = vi.fn(() => current);
      const pendingIds: string[] = [];
      let signal: AbortSignal | undefined;
      const drain = createChannelIngressDrain<Payload>({
        queue,
        shouldSupersedePending: async (_candidate, pending) => {
          pendingIds.push(pending.id);
          return guard;
        },
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "old") {
            signal = lifecycle.abortSignal;
            return { kind: "deferred" };
          }
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });
      try {
        await drain.drainOnce();
        await queue.enqueue("new", { text: "new" }, { laneKey: "shared" });
        expect(await drain.drainOnce()).toEqual({ started: current ? 1 : 0 });
        expect(guard).toHaveBeenCalledOnce();
        expect(pendingIds).toEqual(["old"]);
        expect(signal?.aborted).toBe(current);
        expect((await queue.enqueue("old", { text: "old" })).kind).toBe(
          current ? "completed" : "claimed",
        );
        if (current) {
          await drain.waitForIdle();
          expect((await queue.enqueue("new", { text: "new" })).kind).toBe("completed");
        }
      } finally {
        drain.dispose();
      }
    });
  });

  it("supersedes every released pre-adoption state on one lane", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("album-1", { text: "first" }, { laneKey: "shared" });
      await queue.enqueue("album-2", { text: "second" }, { laneKey: "shared" });
      const signals = new Map<string, AbortSignal>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        shouldSupersedePending: (candidate) => candidate.id === "abort",
        dispatchClaimedEvent: async (event, lifecycle) => {
          if (event.id === "abort") {
            await lifecycle.onAdopted();
            return { kind: "completed" };
          }
          signals.set(event.id, lifecycle.abortSignal);
          return { kind: "deferred" };
        },
      });

      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(signals.size).toBe(1));
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(signals.size).toBe(2));
      expect(await queue.listClaims()).toHaveLength(2);

      await queue.enqueue("abort", { text: "/abort" }, { laneKey: "shared" });
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await drain.waitForIdle();

      expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
      expect(await queue.listClaims()).toEqual([]);
      for (const id of ["album-1", "album-2", "abort"]) {
        expect((await queue.enqueue(id, { text: id })).kind).toBe("completed");
      }
      drain.dispose();
    });
  });

  it("keeps the candidate blocked when a current lane owner is not superseded", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("released", { text: "released" }, { laneKey: "shared" });
      await queue.enqueue("owner", { text: "owner" }, { laneKey: "shared" });
      const ownerGate = createDeferredCore();
      const signals = new Map<string, AbortSignal>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        deferredLaneOccupancy: "release",
        shouldSupersedePending: (candidate, pending) =>
          candidate.id === "abort" && pending.id === "released",
        dispatchClaimedEvent: async (event, lifecycle) => {
          signals.set(event.id, lifecycle.abortSignal);
          if (event.id === "released") {
            return { kind: "deferred" };
          }
          await ownerGate.promise;
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      await vi.waitFor(() => expect(signals.has("released")).toBe(true));
      await drain.drainOnce();
      await vi.waitFor(() => expect(signals.has("owner")).toBe(true));
      await queue.enqueue("abort", { text: "/abort" }, { laneKey: "shared" });

      expect(await drain.drainOnce()).toEqual({ started: 0 });
      expect(signals.get("released")?.aborted).toBe(true);
      expect(signals.get("owner")?.aborted).toBe(false);
      expect((await queue.listPending({ limit: "all" })).map((event) => event.id)).toEqual([
        "abort",
      ]);
      ownerGate.resolve();
      await drain.waitForIdle();
      drain.dispose();
    });
  });
});
