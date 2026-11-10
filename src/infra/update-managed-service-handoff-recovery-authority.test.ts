// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { expect, it } from "vitest";

const { runManagedServiceManagerBoundary: runBoundary } =
  useManagedServiceHandoffLifecycleFixture(true);
const itUnix = it.runIf(process.platform !== "win32");

itUnix.each(["systemd", "launchd"] as const)(
  "does not restart %s when a later start retires the stop during recovery inspection",
  async (kind) => {
    const result = await runBoundary(kind, {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate: "before",
      recoveryInterruption: { effect: "stop-retired", at: "inspection" },
      helperExitCode: 1,
    });
    expect(result.state.recoveryInterrupted, result.log).toBe(true);
    expect(result.state.restored, result.log).toBeUndefined();
    expect(result.state.guardedRestart, result.log).toBeUndefined();
    expect(
      result.commands.filter((command) => /(?:start|bootstrap|kickstart) /.test(command)),
    ).toEqual([]);
    expect(result.log).toContain("Gateway stop intent was superseded");
    expect(result.run).toMatchObject({ status: "failed", phase: "finished" });
  },
);

itUnix.each(["bootstrap-retry", "kickstart"] as const)(
  "does not issue launchd %s after a later start retires recovery authority",
  async (at) => {
    const result = await runBoundary("launchd", {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate: "before",
      recoveryInterruption: { effect: "stop-retired", at },
      ...(at === "kickstart"
        ? { launchdFault: "stopped-loaded" as const }
        : { launchdTeardown: { pendingBootstrapFailures: 1 } }),
      helperExitCode: 1,
    });
    expect(result.state.recoveryInterrupted, result.log).toBe(true);
    expect(result.state.restored, result.log).toBeUndefined();
    expect(result.commands.filter((command) => command.startsWith("bootstrap "))).toHaveLength(
      at === "bootstrap-retry" ? 1 : 0,
    );
    expect(result.commands.filter((command) => command.startsWith("kickstart "))).toEqual([]);
    expect(result.log).toContain("Gateway stop intent was superseded");
  },
);

itUnix.each(["systemd", "launchd"] as const)(
  "does not start %s or publish a terminal result after its helper lease is replaced",
  async (kind) => {
    const result = await runBoundary(kind, {
      ledger: true,
      controlDisconnect: "transferred",
      interruptedUpdate: "before",
      recoveryInterruption: { effect: "lease-replaced", at: "inspection" },
      helperExitCode: 1,
    });
    expect(result.state.recoveryInterrupted, result.log).toBe(true);
    expect(result.state.restored, result.log).toBeUndefined();
    expect(
      result.commands.filter((command) => /(?:start|bootstrap|kickstart) /.test(command)),
    ).toEqual([]);
    expect(result.run).toMatchObject({ status: "running" });
  },
);

itUnix("does not start a reassigned systemd service during interrupted recovery", async () => {
  const result = await runBoundary("systemd", {
    ledger: true,
    controlDisconnect: "transferred",
    interruptedUpdate: "before",
    systemdPostExitStates: [
      { activeState: "inactive", mainPid: "none" },
      { activeState: "inactive", mainPid: "none", id: "replacement.service" },
    ],
    helperExitCode: 1,
  });
  expect(result.state.restored, result.log).toBeUndefined();
  expect(result.commands.filter((command) => command.includes(" start "))).toEqual([]);
  expect(result.log).toContain("parked systemd service identity changed");
});
