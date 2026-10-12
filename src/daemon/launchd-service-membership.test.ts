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

  it.each([
    { action: "install", membership: "inside" },
    { action: "install", membership: "unknown" },
    { action: "uninstall", membership: "ancestor" },
  ] as const)(
    "refuses $action before mutation with $membership service membership",
    async ({ action, membership }) => {
      const env = createDefaultLaunchdEnv();
      const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
      state.serviceStates.set(`${domain}/ai.openclaw.gateway`, "running");
      getSelfAndAncestorPidsSync.mockReturnValue(
        new Set([...launchdCallerPids, membership === "ancestor" ? 4242 : 1]),
      );
      if (membership !== "ancestor") {
        nativeServiceMembership.mockReturnValue(membership);
      }
      const plistPath = resolveLaunchAgentPlistPath(env);
      const previous = createTestLaunchAgentPlist({
        label: "ai.openclaw.gateway",
        programArguments: defaultProgramArguments,
      });
      state.files.set(plistPath, previous);
      await withEnvAsync({ LAUNCH_JOB_LABEL: "ai.openclaw.gateway" }, async () => {
        await expect(
          action === "install"
            ? installLaunchAgent({
                env,
                stdout: new PassThrough(),
                programArguments: defaultProgramArguments,
              })
            : uninstallLaunchAgent({ env, stdout: new PassThrough() }),
        ).rejects.toThrow(
          membership === "unknown"
            ? "Native Gateway service membership could not be verified"
            : `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
        );
      });
      expect(state.fileWrites).toEqual([]);
      expect(state.files.get(plistPath)).toBe(previous);
      expect(state.launchctlCalls).toEqual([["print", `${domain}/ai.openclaw.gateway`]]);
    },
  );

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
