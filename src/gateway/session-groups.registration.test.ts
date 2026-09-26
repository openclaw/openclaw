import { expect, it, vi } from "vitest";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { ensureSessionGroupCatalog } from "./session-group-catalog.js";
import { ensureSessionGroupRegistered, listSessionGroups } from "./session-groups.js";

it.each(["transaction", "commit"] as const)(
  "refuses registration revoked at %s admission",
  async (stage) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await ensureSessionGroupRegistered("Existing");
      const createAdmission = admission.createSqliteWorkerOperationAdmission;
      const stages: string[] = [];
      let current = true;
      const hook = vi
        .spyOn(admission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((callback, attachment) =>
          createAdmission((request, grant) => {
            if (request.stage === "transaction") {
              expect(request.facts).toEqual({ names: ["Existing"] });
            }
            stages.push(request.stage);
            if (request.stage === stage) {
              current = false;
            }
            callback(request, grant);
          }, attachment),
        );
      try {
        await expect(
          ensureSessionGroupRegistered("Refused", process.env, () => {
            if (!current) {
              throw new Error("source revoked");
            }
          }),
        ).rejects.toThrow("source revoked");
        expect(stages).toContain(stage);
        expect(listSessionGroups().map(({ name }) => name)).toEqual(["Existing"]);
      } finally {
        hook.mockRestore();
      }
    });
  },
);

it("reconciles a granted registration after close without replaying the mutation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await ensureSessionGroupCatalog();
    const createAdmission = admission.createSqliteWorkerOperationAdmission;
    let closing: Promise<void> | undefined;
    let commits = 0;
    const hook = vi
      .spyOn(admission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((callback, attachment) =>
        createAdmission((request, grant) => {
          callback(request, grant);
          if (request.stage === "commit") {
            commits++;
            closing = closeOpenClawStateDatabaseAsync();
          }
        }, attachment),
      );
    try {
      await expect(ensureSessionGroupRegistered("Committed")).rejects.toThrow();
      await closing;
      expect(commits).toBe(1);
    } finally {
      hook.mockRestore();
      await closing;
    }
    await ensureSessionGroupCatalog();
    expect(listSessionGroups().map(({ name }) => name)).toEqual(["Committed"]);
  });
});
