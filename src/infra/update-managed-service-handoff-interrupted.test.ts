// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { expect, it } from "vitest";

const { runManagedServiceManagerBoundary: runBoundary } =
  useManagedServiceHandoffLifecycleFixture(true);
const itUnix = it.runIf(process.platform !== "win32");

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
