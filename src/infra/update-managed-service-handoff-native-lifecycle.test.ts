// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import {
  registerManagedRecoveryCommandTests,
  registerManagedLaunchdTeardownTests,
} from "./update-managed-service-handoff-command.test-support.js";
import { registerManagedSystemdHandoffConvergenceTests } from "./update-managed-service-handoff-lifecycle.test-support.js";

const { runManagedServiceManagerBoundary } = useManagedServiceHandoffLifecycleFixture();

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedSystemdHandoffConvergenceTests(runManagedServiceManagerBoundary, itUnix, expect);

  registerManagedRecoveryCommandTests(runManagedServiceManagerBoundary, itUnix, expect);

  itUnix.each([
    ["cannot restart", "start-failed", { startFailed: true }],
    ["reports a dead replacement PID", "dead-restored-pid", { restored: true }],
  ] as const)(
    "records one durable failure when the canonical systemd service %s",
    async (_label, systemdFault, expectedState) => {
      const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
        "systemd",
        { cancelAfterPark: true, systemdFault },
      );

      expect(parentSignal).toBeNull();
      expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(0);
      expect(
        commands.filter((command) => command.includes("start openclaw-gateway.service")),
      ).toHaveLength(1);
      expect(state).toMatchObject({ parked: true, ...expectedState });
      expect(state.triageCalls).toBe(1);
      expect(sentinel).toMatchObject({
        payload: {
          status: "error",
          stats: {
            reason: "managed-service-handoff-restore-failed",
            steps: expect.arrayContaining([
              expect.objectContaining({ name: "service-restore", log: { exitCode: 1 } }),
            ]),
          },
        },
      });
    },
  );

  itUnix("parks and restores the exact launchd service from its detached helper", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("launchd", {
      cancelAfterPark: true,
    });
    const verbs = commands.map((command) => command.split(" ")[0]);
    const disable = verbs.indexOf("disable");
    const bootout = verbs.indexOf("bootout");
    const enable = verbs.indexOf("enable");
    const restart = verbs.findIndex((verb) => verb === "bootstrap" || verb === "kickstart");

    expect(disable).toBeGreaterThan(0);
    expect(commands[0]).toBe("print gui/501/ai.openclaw.gateway");
    expect(bootout).toBeGreaterThan(disable);
    expect(enable).toBeGreaterThan(bootout);
    expect(verbs.slice(bootout + 1, enable)).toContain("print");
    expect(restart).toBeGreaterThan(enable);
    expect(verbs.lastIndexOf("print")).toBeGreaterThan(restart);
    expect(commands[disable]).toBe("disable gui/501/ai.openclaw.gateway");
    expect(commands[bootout]).toBe("bootout gui/501/ai.openclaw.gateway");
    expect(commands.every((command) => !command.includes("kickstart -k"))).toBe(true);
    expect(state).toMatchObject({ disabled: false, parked: true, restored: true });
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: {
          reason: "managed-service-handoff-cancelled",
          steps: expect.arrayContaining([
            expect.objectContaining({ name: "service-restore", log: { exitCode: 0 } }),
          ]),
        },
      },
    });
  });

  registerManagedLaunchdTeardownTests(runManagedServiceManagerBoundary, itUnix, expect);
});
