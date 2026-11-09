// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { expect, it } from "vitest";

const { runManagedServiceManagerBoundary } = useManagedServiceHandoffLifecycleFixture();

it.runIf(process.platform !== "win32").each(["source", "installed"] as const)(
  "keeps %s generated handoff diagnostics off the control stream",
  async (handoffDebugRuntime) => {
    const result = await runManagedServiceManagerBoundary("systemd", {
      handoffDebugRuntime,
      ledger: true,
      controlDisconnect: "transferred",
      validationResult: "failed",
      helperExitCode: 1,
    });

    expect(result.stdout).toBe("OPENCLAW_UPDATE_HANDOFF_READY\ntransferred\n");
    expect(result.stderr.split("\n")).toEqual([
      "[state/sqlite] SQLite handoff fixture for synthetic.sqlite: 1.0 KiB, budget 301 seconds",
      expect.stringMatching(
        /^\[state\/sqlite\] SQLite read-only snapshot for [^\n]+\/state\/openclaw\.sqlite: 1\.5 MiB, budget 302 seconds$/,
      ),
      "",
    ]);
    expect(result.run).toMatchObject({
      status: "failed",
      phase: "finished",
      reason: "candidate-validation-failed",
    });
    expect(result.commands).toEqual([]);
    expect(result.parentSignal).toBeNull();
    expect(result.log).not.toContain("could not be recorded");
  },
);
