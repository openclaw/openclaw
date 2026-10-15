// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { registerManagedTerminalResultTests } from "./update-managed-service-handoff-result.test-support.js";

const { runManagedServiceManagerBoundary, tempDirs } = useManagedServiceHandoffLifecycleFixture();

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedTerminalResultTests(runManagedServiceManagerBoundary, itUnix, expect, tempDirs);
  itUnix.each([undefined, 65_000])(
    "finalizes through the installed runtime after the updater replaces its module graph (work=%s)",
    async (finalizationWorkMs) => {
      const { run, log, state, ledgerWriteBudgets } = await runManagedServiceManagerBoundary(
        "systemd",
        {
          controlDisconnect: "transferred",
          ledger: true,
          observeLedgerBudget: true,
          ...(finalizationWorkMs === undefined ? {} : { ledgerBusyTimeoutMs: 71_000 }),
          replaceLedgerWriter: true,
          finalizationWorkMs,
          recoveryTimeoutMs: finalizationWorkMs === undefined ? undefined : 120_000,
          updaterExitCode: 0,
          updaterResult: { status: "ok", mode: "npm" },
        },
      );
      expect(run).toMatchObject({ status: "succeeded", phase: "finished" });
      expect(ledgerWriteBudgets!.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ledgerWriteBudgets)).toEqual(
        new Set([finalizationWorkMs === undefined ? null : 71_000]),
      );
      if (finalizationWorkMs !== undefined) {
        expect(state.finalizationBudgetMs).toBe(120_000);
      }
      expect(log).not.toContain("the previous runtime must not finalize the candidate");
      expect(log).toContain("managed update finalize command exited code=0");
    },
  );
});
