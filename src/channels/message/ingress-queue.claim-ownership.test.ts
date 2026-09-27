import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createTestIngressQueue, withTempState } from "./ingress-drain.test-helpers.js";

describe("channel ingress claim ownership", () => {
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
