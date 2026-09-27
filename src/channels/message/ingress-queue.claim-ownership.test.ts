import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as workerLifecycle from "../../infra/sqlite-worker-lifecycle-preparation.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

describe("channel ingress claim ownership", () => {
  it.each(["transaction", "commit"] as const)(
    "revalidates live lane policy at native %s admission",
    async (stage) => {
      await withTempState(async (stateDir) => {
        const queue = createChannelIngressQueue<{ lane: string }>({
          channelId: "test",
          accountId: "a",
          stateDir,
        });
        await queue.enqueue(
          "a",
          { lane: "chat:123" },
          { laneKey: "chat:123:topic:7", receivedAt: 1 },
        );
        await queue.enqueue(
          "b",
          { lane: "chat:456" },
          { laneKey: "chat:456:topic:9", receivedAt: 2 },
        );
        let policyChanged = false;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admission = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === stage) {
                policyChanged = true;
              }
              admit(request, grant);
            }, attachment),
          );
        try {
          const claimed = await queue.claimNext({
            ownerId: "worker",
            blockedLaneKeys: ["chat:123"],
            deriveLaneKey: (record) => {
              const laneKey =
                record.id === "a" && !policyChanged ? record.laneKey : record.payload.lane;
              record.payload.lane = "callback-local";
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
            payload: { lane: "chat:123" },
          });
        } finally {
          admission.mockRestore();
        }
      });
    },
  );

  it.each(["policy exception", "owner retirement"] as const)(
    "does not retry a claim after %s during commit policy evaluation",
    async (cause) => {
      await withTempState(async (stateDir) => {
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
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const admission = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "transaction") {
                transactions++;
              }
              committing = request.stage === "commit";
              admit(request, grant);
            }, attachment),
          );
        try {
          await expect(
            queue.claimNext({
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
            }),
          ).rejects.toBe(failure);
          expect(failed).toBe(true);
          expect(transactions).toBe(1);
          const inspector = createChannelIngressQueue(options);
          expect((await inspector.listPending()).map((row) => [row.id, row.laneKey])).toEqual([
            ["event-1", undefined],
          ]);
          expect(await inspector.listClaims()).toEqual([]);
        } finally {
          admission.mockRestore();
        }
      });
    },
  );

  it("does not retry a policy conflict when the native rollback reply is lost", async () => {
    await withTempState(async (stateDir) => {
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
      const prepareLifecycle = workerLifecycle.createSqliteWorkerLifecyclePreparation;
      const lifecycle = vi
        .spyOn(workerLifecycle, "createSqliteWorkerLifecyclePreparation")
        .mockImplementation((params) =>
          prepareLifecycle({
            ...params,
            receiveResult(reply, pumping) {
              if (
                reply &&
                typeof reply === "object" &&
                "id" in reply &&
                reply.id === claimRequest &&
                "ok" in reply &&
                reply.ok === false &&
                stopClaimWorker &&
                !stopped
              ) {
                stopped = stopClaimWorker();
                return;
              }
              params.receiveResult(reply, pumping);
            },
          }),
        );
      const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "commit" && claimRequest !== undefined) {
              policyChanged = true;
            }
            admit(request, grant);
          }, attachment),
        );
      try {
        await queue.enqueue("event-1", { text: "lane" });
        await expect(
          queue.claimNext({
            blockedLaneKeys: ["blocked"],
            deriveLaneKey: (record) => (policyChanged ? "blocked" : record.payload.text),
          }),
        ).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(policyChanged).toBe(true);
        expect(attempts).toBe(1);
        expect(stopped).toBeDefined();
        await stopped;
        expect((await queue.listPending()).map((row) => [row.id, row.laneKey])).toEqual([
          ["event-1", undefined],
        ]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        admission.mockRestore();
        post.mockRestore();
        lifecycle.mockRestore();
        await stopped;
      }
    });
  });

  it.each(["claim", "claimNext"] as const)(
    "starts a %s lease at custom-clock transaction admission",
    async (method) => {
      await withTempState(async (stateDir) => {
        let clock = 10;
        const queue = createTestIngressQueue(stateDir, { now: () => clock });
        await queue.enqueue("event-1", { text: "queued" });
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        let admitted = false;
        const admission = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "transaction") {
                admitted = true;
                clock = 1_000;
              }
              admit(request, grant);
            }, attachment),
          );
        try {
          const claim = method === "claim" ? await queue.claim("event-1") : await queue.claimNext();
          expect(admitted).toBe(true);
          expect(claim?.claim.claimedAt).toBe(1_000);
          expect(await queue.recoverStaleClaims({ now: 1_001, staleMs: 100 })).toBe(0);
          expect((await queue.listClaims())[0]?.claim.token).toBe(claim?.claim.token);
        } finally {
          admission.mockRestore();
        }
      });
    },
  );

  it("requires claim tokens before mutating claimed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(await queue.complete("event-1")).toBe(false);
      expect(await queue.release("event-1")).toBe(false);
      expect(await queue.fail("event-1", { reason: "stale-handler" })).toBe(false);
      expect(await queue.delete("event-1")).toBe(false);

      expect(await queue.complete(claimed, { completedAt: 20 })).toBe(true);
      const duplicate = await queue.enqueue("event-1", { text: "duplicate" });
      expect(duplicate.kind).toBe("completed");
    });
  });

  it("refreshes claimed rows only with the active claim token", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      await queue.enqueue("event-1", { text: "claimed" });
      const claimed = await queue.claim("event-1", { ownerId: "worker" });
      if (!claimed) {
        throw new Error("Expected a claimed ingress event");
      }

      expect(await queue.refreshClaim?.(claimed, { refreshedAt: 20 })).toBe(true);
      expect(
        (await queue.listClaims()).map((claim) => ({
          id: claim.id,
          claimedAt: claim.claim.claimedAt,
          updatedAt: claim.updatedAt,
        })),
      ).toEqual([{ id: "event-1", claimedAt: 20, updatedAt: 20 }]);

      expect(
        await queue.refreshClaim?.(
          { id: "event-1", claim: { token: "wrong" } },
          {
            refreshedAt: 30,
          },
        ),
      ).toBe(false);
      expect((await queue.listClaims())[0]?.claim.claimedAt).toBe(20);
    });
  });

  it("does not let old claim tokens refresh recovered and reclaimed rows", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10 });

      await queue.enqueue("event-1", { text: "claimed" });
      const oldClaim = await queue.claim("event-1", { ownerId: "worker-1" });
      if (!oldClaim) {
        throw new Error("Expected a claimed ingress event");
      }
      expect(await queue.recoverStaleClaims({ staleMs: 5, now: 20 })).toBe(1);
      const newClaim = await queue.claim("event-1", { ownerId: "worker-2" });
      if (!newClaim) {
        throw new Error("Expected reclaimed ingress event");
      }

      expect(await queue.refreshClaim?.(oldClaim, { refreshedAt: 30 })).toBe(false);
      expect(await queue.refreshClaim?.(newClaim, { refreshedAt: 40 })).toBe(true);
      expect((await queue.listClaims())[0]?.claim).toMatchObject({
        ownerId: "worker-2",
        claimedAt: 40,
      });
    });
  });

  it.each(["refreshed", "reclaimed"] as const)(
    "does not recover a claim %s after stale recovery snapshots it",
    async (change) => {
      await withTempState(async (stateDir) => {
        const queue = createTestIngressQueue(stateDir, { now: () => 10 });

        await queue.enqueue("event-1", { text: "claimed" });
        const claimed = await queue.claim("event-1", { ownerId: "worker" });
        if (!claimed) {
          throw new Error("Expected a claimed ingress event");
        }

        let currentClaim = claimed;
        expect(
          await queue.recoverStaleClaims({
            staleMs: 5,
            now: 20,
            shouldRecover: async (claim) => {
              expect(claim.id).toBe("event-1");
              if (change === "refreshed") {
                expect(await queue.refreshClaim?.(claim, { refreshedAt: 20 })).toBe(true);
              } else {
                expect(await queue.release(claim, { recordAttempt: false })).toBe(true);
                currentClaim = expectDefined(
                  await queue.claim(claim.id, { ownerId: "replacement" }),
                  "replacement claim",
                );
                expect(currentClaim.claim.token).not.toBe(claim.claim.token);
              }
              return true;
            },
          }),
        ).toBe(0);
        expect((await queue.listPending()).map((record) => record.id)).toEqual([]);
        expect((await queue.listClaims())[0]?.claim).toMatchObject({
          token: currentClaim.claim.token,
          ownerId: change === "refreshed" ? "worker" : "replacement",
          claimedAt: change === "refreshed" ? 20 : 10,
        });
      });
    },
  );
});
