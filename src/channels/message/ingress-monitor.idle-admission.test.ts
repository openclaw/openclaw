import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { SqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { tryBeginGatewaySuspendAdmission } from "../../process/gateway-work-admission.js";
import { INGRESS_CLAIM_LEASE_MS } from "./ingress-claim-owner.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import {
  createMonitor,
  PermanentIngressError,
  useIngressMonitorQueueFixture,
  type RawEvent,
  type StoredEvent,
} from "./ingress-monitor.test-harness.js";

const withQueue = useIngressMonitorQueueFixture();
const raw: RawEvent = { id: "fresh", lane: "a", text: "synthetic message" };
const payload = { version: 1 as const, rawEvent: JSON.stringify(raw) };

describe("idle ingress admission", () => {
  it("persists a reconciled lane before delivering a fresh singleton", async () => {
    await withQueue(async (queue) => {
      let deliveredLaneKeys: Array<string | undefined> = [];
      const deliver = vi.fn(async () => {
        deliveredLaneKeys = (await queue.listClaims()).map((claim) => claim.laneKey);
      });
      const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
        queue,
        inspect: (event, context) => ({
          eventId: event.id,
          laneKey: context.phase === "admission" ? "lane:old" : "lane:new",
        }),
        payload: {
          storage: "raw-event",
          version: 1,
          serialize: (event) => JSON.stringify(event),
          deserialize: (body) => JSON.parse(body) as RawEvent,
          createClaimError: (kind) => new PermanentIngressError(kind),
        },
        deliver,
        pollIntervalMs: 60_000,
        retention: { pruneIntervalMs: 60_000 },
        drain: {
          deriveLaneKey: () => "lane:new",
          reconcileStoredLaneKey: (_record, stored, derived) =>
            stored === "lane:old" && derived === "lane:new",
          resolveNonRetryableFailure: (error) =>
            error instanceof PermanentIngressError
              ? { reason: "invalid-event", message: error.message }
              : null,
        },
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        await monitor.admit(raw);
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
        expect(deliveredLaneKeys).toEqual(["lane:new"]);
        expect(await queue.enqueue(raw.id, payload)).toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
      }
    });
  });

  it("owns the fresh claim before ACK and delivers once even when ACK fails", async () => {
    await withQueue(async (queue) => {
      const ackEntered = createDeferred();
      const ackRelease = createDeferred();
      const ackError = new Error("synthetic ACK failure");
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver, {
        pollIntervalMs: 60_000,
        onDurableAdmission: async () => {
          ackEntered.resolve();
          await ackRelease.promise;
          throw ackError;
        },
      });
      monitor.start();
      await monitor.waitForIdle();
      const admission = monitor.admit(raw);
      const failedAdmission = expect(admission).rejects.toBe(ackError);
      try {
        await ackEntered.promise;
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({ id: raw.id, payload, attempts: 0 }),
        ]);
        expect(deliver).not.toHaveBeenCalled();
        ackRelease.resolve();
        await failedAdmission;
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
        expect(await queue.enqueue(raw.id, payload)).toMatchObject({ kind: "completed" });
      } finally {
        ackRelease.resolve();
        await failedAdmission;
        await monitor.stop();
      }
    });
  });

  it("refreshes the claim during a slow ACK without starting the dispatch watchdog", async () => {
    await withQueue(async (queue) => {
      const ackEntered = createDeferred();
      const ackRelease = createDeferred();
      const refreshed = createDeferred();
      const refresh = queue.refreshClaim!.bind(queue);
      vi.spyOn(queue, "refreshClaim").mockImplementation(async (...args) => {
        try {
          return await refresh(...args);
        } finally {
          refreshed.resolve();
        }
      });
      let currentTime = Date.now();
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver, {
        now: () => currentTime,
        pollIntervalMs: 24 * 60 * 60 * 1_000,
        onDurableAdmission: async () => {
          ackEntered.resolve();
          await ackRelease.promise;
        },
      });
      monitor.start();
      await monitor.waitForIdle();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const admission = monitor.admit(raw);
      try {
        await ackEntered.promise;
        expect(await queue.listClaims()).toHaveLength(1);
        currentTime += INGRESS_CLAIM_LEASE_MS / 3;
        await vi.advanceTimersByTimeAsync(INGRESS_CLAIM_LEASE_MS / 3);
        await refreshed.promise;
        expect(await queue.listClaims()).toEqual([
          expect.objectContaining({
            id: raw.id,
            attempts: 0,
            claim: expect.objectContaining({ claimedAt: currentTime }),
          }),
        ]);
        expect(deliver).not.toHaveBeenCalled();
        ackRelease.resolve();
        await admission;
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        ackRelease.resolve();
        await admission;
        await monitor.stop();
        vi.useRealTimers();
      }
    });
  });

  it("recovers a committed claim after an unknown append receipt without retry or ACK", async () => {
    await withQueue(async (queue) => {
      const append = queue.enqueueAndClaim!.bind(queue);
      const failure = new Error("synthetic lost receipt", {
        cause: new AggregateError([new SqliteWorkerError("lost reply", "outcome-unknown")]),
      });
      const enqueue = vi.spyOn(queue, "enqueueAndClaim").mockImplementation(async (...args) => {
        await append(...args);
        throw failure;
      });
      const ack = vi.fn();
      const deliver = vi.fn();
      const monitor = createMonitor(queue, deliver, {
        pollIntervalMs: 60_000,
        appendRetryDelaysMs: [0, 0, 0],
        onDurableAdmission: ack,
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        await expect(monitor.admit(raw)).rejects.toBe(failure);
        await monitor.waitForIdle();
        expect(enqueue).toHaveBeenCalledOnce();
        expect(ack).not.toHaveBeenCalled();
        expect(deliver).toHaveBeenCalledOnce();
        expect(await queue.enqueue(raw.id, payload)).toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
      }
    });
  });

  it.each(["stop", "suspend"] as const)(
    "returns an unstarted claim without consuming retries when %s wins during ACK",
    async (action) => {
      await withQueue(async (queue) => {
        const ackEntered = createDeferred();
        const ackRelease = createDeferred();
        const deliver = vi.fn();
        const monitor = createMonitor(queue, deliver, {
          pollIntervalMs: 60_000,
          onDurableAdmission: async () => {
            ackEntered.resolve();
            await ackRelease.promise;
          },
        });
        let suspension: ReturnType<typeof tryBeginGatewaySuspendAdmission> = null;
        let stopping: Promise<void> | undefined;
        monitor.start();
        await monitor.waitForIdle();
        const admission = monitor.admit(raw);
        try {
          await ackEntered.promise;
          expect(await queue.listClaims()).toHaveLength(1);
          if (action === "stop") {
            stopping = monitor.stop();
          } else {
            suspension = tryBeginGatewaySuspendAdmission(() => {});
            expect(suspension?.drain()).toBe(true);
          }
          ackRelease.resolve();
          await admission;
          await stopping;
          await monitor.waitForIdle();
          expect(deliver).not.toHaveBeenCalled();
          expect(await queue.listClaims()).toEqual([]);
          const pending = await queue.listPending();
          expect(pending).toEqual([expect.objectContaining({ id: raw.id, attempts: 0 })]);
          expect(pending[0]).not.toHaveProperty("lastAttemptAt");
          expect(pending[0]).not.toHaveProperty("lastError");
          if (suspension) {
            expect(suspension.release()).toBe(true);
            await monitor.waitForIdle();
            expect(deliver).toHaveBeenCalledOnce();
          } else {
            const replacement = createMonitor(queue, deliver, { pollIntervalMs: 60_000 });
            try {
              replacement.start();
              await replacement.waitForIdle();
              expect(deliver).toHaveBeenCalledOnce();
            } finally {
              await replacement.stop();
            }
          }
        } finally {
          ackRelease.resolve();
          await admission;
          await monitor.stop();
          suspension?.rollback();
          suspension?.release();
        }
      });
    },
  );

  it("keeps a retry-delayed head ahead of fresh input", async () => {
    await withQueue(async (queue) => {
      const head = { ...raw, id: "head" };
      await queue.enqueue(
        head.id,
        { version: 1, rawEvent: JSON.stringify(head) },
        { receivedAt: 1, laneKey: "lane:a" },
      );
      const claim = await queue.claim(head.id);
      expect(claim).not.toBeNull();
      await queue.release(claim!, { releasedAt: 10_000, lastError: "retry later" });
      let currentTime = 10_000;
      const delivered: string[] = [];
      const monitor = createMonitor(
        queue,
        (event) => {
          delivered.push(event.id);
        },
        { pollIntervalMs: 60_000, now: () => currentTime },
      );
      try {
        monitor.start();
        await monitor.waitForIdle();
        await monitor.admit(raw);
        await monitor.waitForIdle();
        expect(delivered).toEqual([]);
        expect((await queue.listPending()).map((event) => event.id)).toEqual(["head", "fresh"]);
        currentTime += 1_000;
        monitor.requestDrain();
        await monitor.waitForIdle();
        expect(delivered).toEqual(["head", "fresh"]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("preserves a peer claim and its payload on duplicate and later admissions", async () => {
    await withQueue(async (queue) => {
      const first = await queue.enqueueAndClaim!(raw.id, payload, {
        ownerId: "peer",
        laneKey: "lane:a",
      });
      expect(first.result).toMatchObject({ kind: "accepted", duplicate: false });
      expect(first.freshClaim).toMatchObject({ claim: { ownerId: "peer" } });
      const duplicate = await queue.enqueueAndClaim!(
        raw.id,
        { version: 1, rawEvent: "different payload" },
        { ownerId: "local" },
      );
      expect(duplicate.freshClaim).toBeUndefined();
      expect(duplicate.result).toMatchObject({ kind: "claimed", duplicate: true });
      const tail = await queue.enqueueAndClaim!("tail", payload, { ownerId: "local" });
      expect(tail.result).toMatchObject({ kind: "accepted" });
      expect(tail.freshClaim).toBeUndefined();
      expect(await queue.listClaims()).toEqual([first.freshClaim]);
      expect((await queue.listPending()).map((event) => event.id)).toEqual(["tail"]);
      expect(await queue.complete(first.freshClaim!)).toBe(true);
      const completed = await queue.enqueueAndClaim!(raw.id, payload, { ownerId: "local" });
      expect(completed.result).toMatchObject({ kind: "completed", duplicate: true });
      expect(completed.freshClaim).toBeUndefined();
      expect(await queue.listClaims()).toEqual([]);
    });
  });

  it("wakes retry settlement for a fused claim without waiting for the poll timer", async () => {
    await withQueue(async (queue) => {
      const deliver = vi
        .fn()
        .mockReturnValueOnce({ kind: "failed-retryable", error: new Error("retry once") })
        .mockReturnValue(undefined);
      const monitor = createMonitor(queue, deliver, {
        pollIntervalMs: 60_000,
        retryPolicy: { baseMs: 0, maxMs: 0 },
      });
      try {
        monitor.start();
        await monitor.waitForIdle();
        await monitor.admit(raw);
        await monitor.waitForIdle();
        expect(deliver).toHaveBeenCalledTimes(2);
        expect(await queue.enqueue(raw.id, payload)).toMatchObject({ kind: "completed" });
      } finally {
        await monitor.stop();
      }
    });
  });
});
