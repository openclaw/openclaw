import { describe, expect, it, vi } from "vitest";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

describe("source-authorized ingress enqueue", () => {
  it.each(["transaction", "commit"] as const)(
    "refuses a source retired at %s without revoking its shared account queue",
    async (stage) => {
      await withOpenClawTestState(
        { layout: "state-only", label: "event-enqueue-authority", applyEnv: false },
        async ({ stateDir }) => {
          const queue = createChannelIngressQueue<{ text: string }>({
            channelId: "source",
            accountId: "account",
            stateDir,
          });
          if (!queue.enqueueAuthorized) {
            throw new Error("Missing authorized ingress capability");
          }
          await queue.enqueue("retained", { text: "already accepted" });
          let current = true;
          let reached = false;
          const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
          const admission = vi
            .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
            .mockImplementation((admit, attachment) =>
              createAdmission((request, grant) => {
                if (request.stage === stage) {
                  reached = true;
                  current = false;
                }
                admit(request, grant);
              }, attachment),
            );
          try {
            await expect(
              queue.enqueueAuthorized(
                "retired",
                { text: "must not persist" },
                {
                  assertCurrent: () => {
                    if (!current) {
                      throw new Error("source retired");
                    }
                  },
                },
              ),
            ).rejects.toThrow("source retired");
            expect(reached).toBe(true);
          } finally {
            admission.mockRestore();
          }
          expect((await queue.listPending()).map((row) => row.id)).toEqual(["retained"]);
          await queue.enqueue("sibling", { text: "independent source" });
          expect((await queue.listPending()).map((row) => row.id).toSorted()).toEqual([
            "retained",
            "sibling",
          ]);
        },
      );
    },
  );
});
