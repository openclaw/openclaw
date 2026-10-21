import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as workerReplies from "../../infra/sqlite-worker-broker-reply.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type Queue = ReturnType<typeof createChannelIngressQueue>;
type AdmissionRequest = Parameters<Parameters<typeof probe.admission>[1]>[0];
const onAdmission = (stage: AdmissionRequest["stage"], inspect: () => void) =>
  probe.admission(workerAdmission, (request, grant, admit) => {
    if (request.stage === stage) {
      inspect();
    }
    admit(request, grant);
  });
async function expectRolledBack(queue: Pick<Queue, "listPending" | "listClaims">) {
  expect((await queue.listPending()).map((row) => [row.id, row.laneKey])).toEqual([
    ["event-1", undefined],
  ]);
  expect(await queue.listClaims()).toEqual([]);
}
async function seedClaim(stateDir: string) {
  const queue = createTestIngressQueue(stateDir, { now: () => 10 });
  await queue.enqueue("event-1", { text: "claimed" });
  const claimed = expectDefined(await queue.claim("event-1", { ownerId: "worker" }), "claim");
  return { queue, claimed };
}

describe("channel ingress claim ownership", () => {
  it("deduplicates batched and competing admissions without replacing the first payload", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 100 });
      await queue.enqueue("completed", { text: "processed" });
      await queue.complete("completed");
      const [batch, competing] = await Promise.all([
        queue.enqueueBatch!([
          { id: "second", payload: { text: "first payload" }, receivedAt: 102 },
          { id: "first", payload: { text: "earlier" }, receivedAt: 101 },
          { id: "completed", payload: { text: "replay" } },
          { id: "second", payload: { text: "duplicate payload" }, receivedAt: 103 },
        ]),
        queue.enqueue("second", { text: "competing payload" }),
      ]);
      expect(batch.map((result) => result.kind)).toEqual([
        "accepted",
        "accepted",
        "completed",
        "pending",
      ]);
      expect(competing).toMatchObject({
        kind: "pending",
        record: { payload: { text: "first payload" } },
      });
      expect((await queue.listPending()).map(({ id, payload }) => ({ id, payload }))).toEqual([
        { id: "first", payload: { text: "earlier" } },
        { id: "second", payload: { text: "first payload" } },
      ]);
    });
  });

  it.each(["transaction", "commit"] as const)(
    "revalidates live lane policy at native %s admission",
    (stage) =>
      withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir);
        for (const [id, lane, laneKey, receivedAt] of [
          ["a", "chat:123", "chat:123:topic:7", 1],
          ["b", "chat:456", "chat:456:topic:9", 2],
        ] as const) {
          await queue.enqueue(id, { text: lane }, { laneKey, receivedAt });
        }
        let policyChanged = false;
        using _ = onAdmission(stage, () => {
          policyChanged = true;
        });
        const claimed = await queue.claimNext({
          ownerId: "worker",
          blockedLaneKeys: ["chat:123"],
          deriveLaneKey: (record) => {
            const laneKey =
              record.id === "a" && !policyChanged ? record.laneKey : record.payload.text;
            record.payload.text = "callback-local";
            return laneKey;
          },
          reconcileStoredLaneKey: (_record, stored, derived) =>
            stored === `${derived}:topic:7` || stored === `${derived}:topic:9`,
        });
        expect(policyChanged).toBe(true);
        expect(claimed).toMatchObject({ id: "b", laneKey: "chat:456" });
        expect((await queue.listClaims()).map((row) => [row.id, row.laneKey])).toEqual([
          ["b", "chat:456"],
        ]);
        expect((await queue.listPending())[0]).toMatchObject({
          id: "a",
          laneKey: "chat:123:topic:7",
          payload: { text: "chat:123" },
        });
      }),
  );

  it.each(["policy exception", "owner retirement"] as const)(
    "does not retry after commit-time %s",
    (cause) =>
      withTempState(async (stateDir) => {
        const failure = new Error(cause);
        const options = { channelId: "test", accountId: "a", stateDir };
        let current = true;
        const queue = createChannelIngressQueue<{ text: string }>(options, () => {
          if (!current) {
            throw failure;
          }
        });
        await queue.enqueue("event-1", { text: "lane" });
        let committing = false;
        let failed = false;
        let transactions = 0;
        using _ = probe.admission(workerAdmission, (request, grant, admit) => {
          if (request.stage === "transaction") {
            transactions++;
          }
          committing = request.stage === "commit";
          admit(request, grant);
        });
        const claiming = queue.claimNext({
          deriveLaneKey: (record) => {
            if (committing && !failed) {
              failed = true;
              if (cause === "owner retirement") {
                current = false;
              } else {
                throw failure;
              }
            }
            return record.payload.text;
          },
        });
        await expect(claiming).rejects.toBe(failure);
        expect([failed, transactions]).toEqual([true, 1]);
        await expectRolledBack(createChannelIngressQueue(options));
      }),
  );

  it("does not retry after a lost native rollback reply", () =>
    withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      let policyChanged = false;
      let stopped: Promise<number> | undefined;
      let stopClaimWorker: (() => Promise<number>) | undefined;
      let claimRequest: number | undefined;
      let attempts = 0;
      // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver below.
      const originalPost = Worker.prototype.postMessage;
      const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type === "execute") {
          const command: unknown = deserialize(request.input);
          if (
            command &&
            typeof command === "object" &&
            "type" in command &&
            command.type === "channelIngress.claimNext"
          ) {
            stopClaimWorker = () => this.terminate();
            claimRequest = request.id;
            attempts++;
          }
        }
        return originalPost.call(this, request, transferList);
      });
      const receiveReply = workerReplies.receiveSqliteWorkerReply;
      const replies = vi
        .spyOn(workerReplies, "receiveSqliteWorkerReply")
        .mockImplementation((slot, reply, owner) => {
          if (reply.id === claimRequest && !reply.ok && stopClaimWorker && !stopped) {
            stopped = stopClaimWorker();
            return;
          }
          receiveReply(slot, reply, owner);
        });
      const admission = onAdmission("commit", () => {
        policyChanged ||= claimRequest !== undefined;
      });
      try {
        await queue.enqueue("event-1", { text: "lane" });
        const claiming = queue.claimNext({
          blockedLaneKeys: ["blocked"],
          deriveLaneKey: (record) => (policyChanged ? "blocked" : record.payload.text),
        });
        await expect(claiming).rejects.toMatchObject({ code: "outcome-unknown" });
        expect({ policyChanged, attempts }).toEqual({ policyChanged: true, attempts: 1 });
        expect(stopped).toBeDefined();
        await stopped;
        await expectRolledBack(queue);
      } finally {
        admission.mockRestore();
        post.mockRestore();
        replies.mockRestore();
        await stopped;
      }
    }));

  it.each(["claim", "claimNext"] as const)("starts %s leases at custom-clock admission", (method) =>
    withTempState(async (stateDir) => {
      let clock = 10;
      const queue = createTestIngressQueue(stateDir, { now: () => clock });
      await queue.enqueue("event-1", { text: "queued" });
      let admitted = false;
      using _ = onAdmission("transaction", () => {
        admitted = true;
        clock = 1_000;
      });
      const claim = method === "claim" ? await queue.claim("event-1") : await queue.claimNext();
      expect([admitted, claim?.claim.claimedAt]).toEqual([true, 1_000]);
      expect(await queue.recoverStaleClaims({ now: 1_001, staleMs: 100 })).toBe(0);
      expect((await queue.listClaims())[0]?.claim.token).toBe(claim?.claim.token);
    }),
  );

  it("requires claim tokens before mutating claimed rows", () =>
    withTempState(async (stateDir) => {
      const { queue, claimed } = await seedClaim(stateDir);
      expect([
        await queue.complete("event-1"),
        await queue.release("event-1"),
        await queue.fail("event-1", { reason: "stale-handler" }),
        await queue.delete("event-1"),
      ]).toEqual([false, false, false, false]);

      expect(await queue.complete(claimed, { completedAt: 20 })).toBe(true);
      expect(await queue.enqueue("event-1", { text: "duplicate" })).toMatchObject({
        kind: "completed",
      });
    }));

  it.each(["refreshed", "reclaimed", "recovered"] as const)(
    "fences recovery and refresh against %s claims",
    (change) =>
      withTempState(async (stateDir) => {
        const { queue, claimed } = await seedClaim(stateDir);
        let currentClaim = claimed;
        const reclaim = async () => {
          currentClaim = expectDefined(
            await queue.claim(claimed.id, { ownerId: "replacement" }),
            "replacement claim",
          );
          expect(currentClaim.claim.token).not.toBe(claimed.claim.token);
        };
        if (change === "recovered") {
          expect(await queue.recoverStaleClaims({ staleMs: 5, now: 20 })).toBe(1);
          await reclaim();
        } else {
          const recovered = await queue.recoverStaleClaims({
            staleMs: 5,
            now: 20,
            shouldRecover: async (claim) => {
              expect(claim.id).toBe("event-1");
              if (change === "refreshed") {
                expect(await queue.refreshClaim?.(claim, { refreshedAt: 20 })).toBe(true);
              } else {
                expect(await queue.release(claim, { recordAttempt: false })).toBe(true);
                await reclaim();
              }
              return true;
            },
          });
          expect(recovered).toBe(0);
        }
        expect((await queue.listPending()).map((record) => record.id)).toEqual([]);
        expect((await queue.listClaims())[0]?.claim).toMatchObject({
          token: currentClaim.claim.token,
          ownerId: change === "refreshed" ? "worker" : "replacement",
          claimedAt: change === "refreshed" ? 20 : 10,
        });
        if (change === "recovered") {
          expect(await queue.refreshClaim?.(claimed, { refreshedAt: 30 })).toBe(false);
          expect((await queue.listClaims())[0]?.claim.claimedAt).toBe(10);
          expect(await queue.refreshClaim?.(currentClaim, { refreshedAt: 40 })).toBe(true);
          expect(await queue.listClaims()).toMatchObject([
            { id: "event-1", updatedAt: 40, claim: { ownerId: "replacement", claimedAt: 40 } },
          ]);
        }
      }),
  );
});
