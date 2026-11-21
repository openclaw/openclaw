import { expect, it } from "vitest";
import { createPreparedTestApprovalManager } from "./exec-approval-manager.test-support.js";
import {
  insertOperatorApproval,
  listPendingOperatorApprovals,
  prepareOperatorApprovalReplay,
} from "./operator-approval-store.js";
import { listPendingOperatorApprovalsInDatabase } from "./operator-approval-store.kernel.worker.js";
import { createOperatorApproval } from "./operator-approval-store.test-support.js";

it("applies live exec selection before limiting both worker and receipt-maintained replay", async (test) => {
  const fixture = await createPreparedTestApprovalManager(test);
  await fixture.run(async () => {
    const { databaseOptions } = fixture;
    for (const [id, createdAtMs, kind] of [
      ["unrelated", 1_000, "exec"],
      ["creator", 2_000, "exec"],
      ["ordinary-plugin", 3_000, "plugin"],
    ] as const) {
      await insertOperatorApproval({
        databaseOptions,
        approval: createOperatorApproval(id, {
          kind,
          createdAtMs,
          reviewerDeviceIds: ["reviewer"],
        }),
      });
    }
    const selection = {
      databaseOptions,
      reviewerDeviceId: "reviewer",
      execApprovalIds: ["creator"],
      nowMs: 4_000,
      limit: 1,
    };
    expect(listPendingOperatorApprovalsInDatabase(selection).map((record) => record.id)).toEqual([
      "creator",
    ]);
    for (const read of [
      listPendingOperatorApprovals,
      async (input: typeof selection) => (await prepareOperatorApprovalReplay(input)).records,
    ]) {
      expect((await read(selection)).map((record) => record.id)).toEqual(["creator"]);
      expect(
        (await read({ ...selection, execApprovalIds: [] })).map((record) => record.id),
      ).toEqual(["ordinary-plugin"]);
    }
    expect(
      (await listPendingOperatorApprovals({ ...selection, execApprovalIds: undefined })).map(
        (record) => record.id,
      ),
    ).toEqual(["unrelated"]);
  });
});
