import { expect, it } from "vitest";
import { createPreparedTestApprovalManager } from "./exec-approval-manager.test-support.js";
import type { OperatorApprovalExecSelection } from "./operator-approval-reviewer-binding.js";
import {
  insertOperatorApproval,
  listPendingOperatorApprovals,
  prepareOperatorApprovalReplay,
} from "./operator-approval-store.js";
import { listPendingOperatorApprovalsInDatabase } from "./operator-approval-store.kernel.worker.js";
import { createOperatorApproval } from "./operator-approval-store.test-support.js";

it("applies session participation selection before limiting both worker and receipt-maintained replay", async (test) => {
  const fixture = await createPreparedTestApprovalManager(test);
  await fixture.run(async () => {
    const { databaseOptions } = fixture;
    for (const [id, createdAtMs, kind, reviewer] of [
      ["unrelated", 1_000, "exec", "reviewer"],
      ["creator", 2_000, "exec", "participant"],
      ["ordinary-plugin", 3_000, "plugin", "reviewer"],
    ] as const) {
      await insertOperatorApproval({
        databaseOptions,
        approval: createOperatorApproval(id, {
          kind,
          createdAtMs,
          reviewerDeviceIds: [reviewer],
        }),
      });
    }
    const execApprovalSelection: OperatorApprovalExecSelection | undefined = {
      include: ["creator"],
      exclude: [],
      ordinary: false,
    };
    const selection = {
      databaseOptions,
      reviewerDeviceId: "reviewer",
      execApprovalSelection,
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
      const only = (choice: OperatorApprovalExecSelection) =>
        read({ ...selection, execApprovalSelection: choice });
      // An empty participant-only selection still returns non-exec approvals.
      expect(
        (await only({ include: [], exclude: [], ordinary: false })).map((record) => record.id),
      ).toEqual(["ordinary-plugin"]);
      // Ordinary reviewers keep reviewer selection outside the named participation approvals.
      expect(
        (await only({ include: ["creator"], exclude: ["unrelated"], ordinary: true })).map(
          (record) => record.id,
        ),
      ).toEqual(["creator"]);
    }
    expect(
      (await listPendingOperatorApprovals({ ...selection, execApprovalSelection: undefined })).map(
        (record) => record.id,
      ),
    ).toEqual(["unrelated"]);
  });
});
