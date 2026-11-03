import { afterEach, expect, it, vi } from "vitest";
import { withSqliteReaderOwner } from "../infra/sqlite-reader-lifecycle.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sqlite/transaction" ? { ...logger, warn } : logger;
    },
  };
});

afterEach(() => warn.mockClear());

it("attributes shared-state holds to the worker command unless the owner supplies a label", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "state-write-diagnostics-" },
    async () => {
      const database = openOpenClawStateDatabase();
      warn.mockClear();
      withSqliteReaderOwner({ operation: "pluginState.register", ownerKind: "worker" }, () => {
        for (const operationLabel of [undefined, "plugin-state.import"]) {
          expect(
            runOpenClawStateWriteTransaction(
              () => "committed",
              { database },
              {
                operationLabel,
                slowTransactionHoldMs: 0,
              },
            ),
          ).toBe("committed");
        }
      });
      expect(warn.mock.calls).toEqual([
        [
          "slow SQLite transaction hold",
          expect.objectContaining({
            database: database.path,
            mode: "immediate",
            operation: "pluginState.register",
          }),
        ],
        [
          "slow SQLite transaction hold",
          expect.objectContaining({
            database: database.path,
            mode: "immediate",
            operation: "plugin-state.import",
          }),
        ],
      ]);
    },
  );
});
