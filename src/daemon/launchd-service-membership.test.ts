await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  nativeServiceMembership,
  getSelfAndAncestorPidsSync,
  launchdCallerPids,
  launchdRestartHandoffState,
  installLaunchAgent,
  setLegacyGatewayLaunchAgentPlist,
  registerLaunchdAncestryTests,
} from "./launchd-ancestry.test-support.js";
import {
  createDefaultLaunchdEnv,
  createTestLaunchAgentPlist,
  defaultProgramArguments,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  parkCurrentLaunchAgentForMaintenance,
  resolveLaunchAgentPlistPath,
  restartLaunchAgent,
  stopLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";

registerLaunchdAncestryTests();

describe("LaunchAgent service membership", () => {
  it("surfaces detached handoff failures", async () => {
    const env = createDefaultLaunchdEnv();
    nativeServiceMembership.mockReturnValue("inside");
    launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff.mockReturnValue({
      ok: false,
      error: "spawn failed",
    });

    await expect(
      withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () =>
        restartLaunchAgent({
          env,
          stdout: new PassThrough(),
        }),
      ),
    ).rejects.toThrow("launchd restart handoff failed: spawn failed");
  });

  it.each(["inside", "unknown"] as const)(
    "refuses reinstall after reparenting to launchd when native membership is %s",
    async (membership) => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      state.serviceStates.set(`${domain}/ai.openclaw.gateway`, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 1]));
      nativeServiceMembership.mockReturnValue(membership);
      state.files.set(
        resolveLaunchAgentPlistPath(env),
        createTestLaunchAgentPlist({
          label: "ai.openclaw.gateway",
          programArguments: defaultProgramArguments,
        }),
      );
      await withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () => {
        await expect(
          installLaunchAgent({
            env,
            stdout: new PassThrough(),
            programArguments: defaultProgramArguments,
          }),
        ).rejects.toThrow(
          membership === "inside"
            ? "Refusing to install LaunchAgent"
            : "Native Gateway service membership could not be verified",
        );
      });
      expect(state.fileWrites).toEqual([]);
      expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
    },
  );

  it("refuses an in-band uninstall before bootout or plist removal", async () => {
    const env = createDefaultLaunchdEnv();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    const plistPath = resolveLaunchAgentPlistPath(env);
    const previous = "RunAtLoad=true";
    state.files.set(plistPath, previous);

    await withEnvAsync({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }, async () => {
      await expect(uninstallLaunchAgent({ env, stdout: new PassThrough() })).rejects.toThrow(
        "Refusing to uninstall LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway",
      );
    });

    expect(state.files.get(plistPath)).toBe(previous);
    expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
  });

  it("refuses an in-band reinstall before booting out its own LaunchAgent", async () => {
    const env = createDefaultLaunchdEnv();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    state.serviceStates.set(`${domain}/ai.openclaw.gateway`, "running");
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

    await withEnvAsync({ XPC_SERVICE_NAME: "ai.openclaw.gateway" }, async () => {
      await expect(
        installLaunchAgent({
          env,
          stdout: new PassThrough(),
          programArguments: defaultProgramArguments,
        }),
      ).rejects.toThrow(
        "Refusing to install LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway",
      );
    });

    expect(state.fileWrites).toEqual([]);
    expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
  });

  it.each([undefined, true])(
    "refuses in-band LaunchAgent stop before any native mutation (disable=%s)",
    async (disable) => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
      await withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () => {
        await expect(stopLaunchAgent({ env, stdout: new PassThrough(), disable })).rejects.toThrow(
          "Refusing to stop LaunchAgent ai.openclaw.gateway from inside the same launchd service",
        );
      });
      expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
    },
  );

  it("disables the current LaunchAgent before scheduling maintenance bootout", async () => {
    const env = createDefaultLaunchdEnv();
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    state.disableCode = 0;

    await withEnvAsync(
      {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
      },
      async () => {
        await expect(parkCurrentLaunchAgentForMaintenance({ env })).resolves.toBe(true);
      },
    );

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    expect(state.launchctlCalls).toEqual([
      ["print", `${domain}/ai.openclaw.gateway`],
      ["disable", `${domain}/ai.openclaw.gateway`],
    ]);
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark).toHaveBeenCalledWith({
      env,
      waitForPid: process.pid,
    });
  });

  it("re-enables the LaunchAgent when the maintenance handoff cannot spawn", async () => {
    const env = createDefaultLaunchdEnv();
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    state.disableCode = 0;
    launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark.mockReturnValueOnce({
      ok: true,
      value: Promise.resolve(false),
    });

    await withEnvAsync(
      {
        LAUNCH_JOB_LABEL: "ai.openclaw.gateway",
      },
      async () => {
        await expect(parkCurrentLaunchAgentForMaintenance({ env })).rejects.toThrow(
          "helper failed to spawn; restored launchd enable state",
        );
      },
    );

    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    expect(state.launchctlCalls).toEqual([
      ["print", `${domain}/ai.openclaw.gateway`],
      ["disable", `${domain}/ai.openclaw.gateway`],
      ["enable", `${domain}/ai.openclaw.gateway`],
    ]);
  });

  it("hands restart off to a detached helper when invoked from the current LaunchAgent", async () => {
    const env = createDefaultLaunchdEnv();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));

    const result = await withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () =>
      restartLaunchAgent(launchAgentControlFixture(env)),
    );

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "kickstart",
      waitForPid: process.pid,
    });
    expect(state.launchctlCalls).toStrictEqual([["print", `${domain}/ai.openclaw.gateway`]]);
  });

  it("hands plist reload off when current LaunchAgent needs rewritten paths", async () => {
    const env = createDefaultLaunchdEnv();
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    const plistPath = resolveLaunchAgentPlistPath(env);
    setLegacyGatewayLaunchAgentPlist(plistPath, [
      "    <key>StandardOutPath</key>",
      "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
    ]);

    const result = await withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () =>
      restartLaunchAgent(launchAgentControlFixture(env)),
    );

    expect(result).toEqual({ outcome: "scheduled" });
    expect(launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff).toHaveBeenCalledWith({
      env,
      mode: "reload",
      waitForPid: process.pid,
    });
    expect(state.files.get(plistPath)).toContain("/Users/test/Library/Logs/openclaw/gateway.log");
    expect(state.launchctlCalls).toStrictEqual([["print", `${domain}/ai.openclaw.gateway`]]);
  });
});
