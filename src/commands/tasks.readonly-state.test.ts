// Task read-command regressions cover fresh shared-state behavior.
import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  resetTaskFlowRegistryForTests,
  resetTaskRegistryForTests,
} from "../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { tasksAuditCommand, tasksListCommand } from "./tasks.js";

describe("task inspection shared-state access", () => {
  it("lists and audits an absent registry without creating the shared database", async () => {
    await withOpenClawTestState(
      { label: "tasks-readonly-state", layout: "state-only", scenario: "minimal" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
        const databasePath = resolveOpenClawStateSqlitePath(state.env);
        const runtime = {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
          writeJson: vi.fn(),
          writeStdout: vi.fn(),
        };

        expect(fs.existsSync(databasePath)).toBe(false);
        await tasksListCommand({ json: true }, runtime);
        await tasksAuditCommand({ json: true }, runtime);

        expect(fs.existsSync(databasePath)).toBe(false);
        expect(runtime.writeJson).toHaveBeenCalledTimes(2);
        resetTaskRegistryForTests({ persist: false });
        resetTaskFlowRegistryForTests({ persist: false });
      },
    );
  });
});
