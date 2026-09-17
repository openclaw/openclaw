import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  getOperatorApprovalDetailedAsync,
  listTerminalOperatorApprovalsAsync,
  OperatorApprovalHistoryCursorError,
} from "./operator-approval-store.async.js";
import { insertOperatorApproval } from "./operator-approval-store.js";

it("expires approvals and returns retained history without host SQLite calls", async () => {
  await withOpenClawTestState({ label: "operator-approval-worker" }, async (state) => {
    const databaseOptions = { env: state.env };
    insertOperatorApproval({
      databaseOptions,
      approval: {
        id: "approval-worker",
        kind: "exec",
        presentation: {
          kind: "exec",
          commandText: "echo fixture",
          commandPreview: "echo fixture",
          warningText: null,
          host: "gateway",
          nodeId: null,
          agentId: "main",
          allowedDecisions: ["allow-once", "deny"],
        },
        runtimeEpoch: "worker-test",
        createdAtMs: 1_000,
        expiresAtMs: 2_000,
      },
    });
    const native = requireNodeSqlite();
    const counters = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(native.StatementSync.prototype, method),
      ),
    ];
    try {
      const calibration = new native.DatabaseSync(":memory:");
      try {
        calibration.exec("CREATE TABLE calibration (value INTEGER)");
        calibration.prepare("INSERT INTO calibration VALUES (?)").run(1);
        const read = calibration.prepare("SELECT value FROM calibration");
        read.get();
        read.all();
        expect([...read.iterate()]).toHaveLength(1);
        expect(counters.every((counter) => counter.mock.calls.length > 0)).toBe(true);
      } finally {
        calibration.close();
        counters.forEach((counter) => counter.mockClear());
      }
      await expect(
        getOperatorApprovalDetailedAsync({ id: "approval-worker", nowMs: 2_001, databaseOptions }),
      ).resolves.toMatchObject({
        outcome: "found",
        record: { id: "approval-worker", status: "expired", terminalReason: "timeout" },
      });
      await expect(
        listTerminalOperatorApprovalsAsync({ nowMs: 2_002, databaseOptions }),
      ).resolves.toMatchObject({
        records: [{ id: "approval-worker", status: "expired" }],
      });
      await expect(
        listTerminalOperatorApprovalsAsync({ cursor: "invalid", databaseOptions }),
      ).rejects.toBeInstanceOf(OperatorApprovalHistoryCursorError);
      expect(counters.map((counter) => counter.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      counters.forEach((counter) => counter.mockRestore());
    }
  });
});
