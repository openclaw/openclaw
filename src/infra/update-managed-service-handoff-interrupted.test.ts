// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { expect, it } from "vitest";

const { runManagedServiceManagerBoundary: runBoundary } =
  useManagedServiceHandoffLifecycleFixture(true);
const itUnix = it.runIf(process.platform !== "win32");

itUnix("uses the verified installed writer when post-core repair migrates then fails", async () => {
  const result = await runBoundary("systemd", {
    ledger: true,
    controlDisconnect: "transferred",
    interruptedUpdate: "after",
    finalizeFailure: true,
    helperExitCode: 1,
  });
  expect(result.state.postCoreRepaired, result.log).toBe(true);
  expect(result.state.restored).toBeUndefined();
  expect(result.run, result.log).toMatchObject({ status: "failed", phase: "finished" });
  expect(result.log).toContain("post-core repair did not complete");
  expect(result.log).not.toMatch(/no such column|failed to finalize update run/);
});

itUnix.each(["before-recovery", "service-inspection"] as const)(
  "does not restart an operator-stopped replacement recorded at %s",
  async (operatorRestart) => {
    const result = await runBoundary("systemd", {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate: operatorRestart === "before-recovery" ? "after" : "before",
      operatorRestart,
      helperExitCode: 1,
    });
    expect(result.state.operatorRestartError, JSON.stringify(result.state)).toBeUndefined();
    expect(result.log).toContain("update command exited code=null signal=SIGKILL");
    expect(result.state.restored, result.log).toBeUndefined();
    expect(result.state.guardedRestart).toBeUndefined();
    expect(result.state.postCoreRepaired, result.log).toBeUndefined();
    expect(result.log).toMatch(/stop intent was superseded/);
    expect(result.run, result.log).toMatchObject({ status: "failed", phase: "finished" });
  },
);

itUnix.each([
  ...(["before", "prepared", "publishing", "after"] as const).map((interruptedUpdate) => ({
    interruptedUpdate,
    updaterStopped: undefined,
  })),
  { interruptedUpdate: "before" as const, updaterStopped: "legacy" as const },
  ...(["before", "publishing", "after"] as const).map((interruptedUpdate) => ({
    interruptedUpdate,
    updaterStopped: "native" as const,
  })),
])(
  "recovers after SIGKILL at $interruptedUpdate publication (updater stop: $updaterStopped)",
  async ({ interruptedUpdate, updaterStopped }) => {
    const forward = interruptedUpdate === "publishing" || interruptedUpdate === "after";
    const result = await runBoundary("systemd", {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate,
      updaterStopped,
      helperExitCode: forward ? 0 : 1,
    });
    expect(result.state, result.log).toMatchObject({
      restored: true,
      healthProbed: true,
      expectedVersion: forward ? "2.0.0" : "1.0.0",
    });
    expect(result.log).toContain("update command exited code=null signal=SIGKILL");
    expect(result.run, result.log).toMatchObject({
      status: forward ? "succeeded" : "rolled-back",
      phase: "finished",
    });
    expect(result.publication).toEqual({
      installedVersion: forward ? "2.0.0" : "1.0.0",
      launcher: forward ? "candidate launcher\n" : "old launcher\n",
      publicationPending: false,
    });
    expect(result.log).not.toMatch(
      /Cannot find module|ERR_MODULE_NOT_FOUND|failed to finalize update run/,
    );
    if (forward || updaterStopped) {
      expect(result.state).toMatchObject({
        ...(forward ? { postCoreRepaired: true, repairRunId: result.run?.runId } : {}),
        guardedRestart: ["gateway", "restart", "--preserve-definition", "--json"],
      });
    }
  },
);

itUnix(
  "keeps the Gateway stopped with terminal guidance after recorded data risk and SIGKILL",
  async () => {
    const result = await runBoundary("systemd", {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate: "risk",
      updaterStopped: "native" as const,
      helperExitCode: 1,
    });
    expect(result.state.restored).toBeUndefined();
    expect(result.log).toContain("update command exited code=null signal=SIGKILL");
    expect(result.state.postCoreRepaired).toBeUndefined();
    expect(result.state.triageCalls).toBeUndefined();
    expect(result.run, result.log).toMatchObject({
      status: "failed",
      phase: "finished",
      verification: { recovery: { serviceRestartSafe: false, dataAtRisk: "unreadable-state" } },
    });
    expect(result.log).toContain("data at risk (unreadable-state)");
    expect(result.log).toContain("openclaw update repair and openclaw gateway status --deep");
    expect(result.log).not.toMatch(
      /unverified installed runtime executed|Cannot find module|ERR_MODULE_NOT_FOUND|failed to finalize update run/,
    );
  },
);

itUnix.each([
  { interruptedUpdate: "prepared", pluginCohort: "own" },
  { interruptedUpdate: "after", pluginCohort: "own" },
  { interruptedUpdate: "after", pluginCohort: "foreign" },
  { interruptedUpdate: "prepared", pluginCohort: "risk" },
] as const)(
  "settles only this run's plugin cohort after SIGKILL at $interruptedUpdate ($pluginCohort)",
  async ({ interruptedUpdate, pluginCohort }) => {
    const own = pluginCohort === "own";
    const forward = interruptedUpdate === "after";
    if (pluginCohort === "risk") {
      // A failed repair that recorded data risk keeps even the original Gateway stopped.
      const result = await runBoundary("systemd", {
        ledger: true,
        controlDisconnect: "transferred",
        interruptedUpdate,
        pluginCohort,
        helperExitCode: 1,
      });
      expect(result.state.restored).toBeUndefined();
      expect(result.log).toContain("data at risk (incomplete-migration)");
      return;
    }
    const result = await runBoundary("systemd", {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate,
      pluginCohort,
      helperExitCode: own && forward ? 0 : 1,
    });
    expect(result.run, result.log).toMatchObject({
      status: own ? (forward ? "succeeded" : "rolled-back") : "failed",
      phase: "finished",
    });
    // Another run's recovery is never this helper's to settle.
    expect(result.publication).toMatchObject({ cohort: own ? "settled" : "pending" });
    expect(result.state.postCoreRepaired).toBe(own ? true : undefined);
    if (own) {
      expect(result.state.restored).toBe(true);
    } else {
      expect(result.log).toContain("post-core repair did not complete");
    }
  },
);
