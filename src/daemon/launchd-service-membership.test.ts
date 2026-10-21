await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));

import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/501";
const serviceId = `${domain}/ai.openclaw.gateway`;
const handoff = launchdRestartHandoffState.scheduleDetachedLaunchdRestartHandoff;
const expectCalls = (...commands: string[][]) =>
  expect(state.launchctlCalls).toStrictEqual(commands.map((command) => command.concat(serviceId)));
let env: ReturnType<typeof createDefaultLaunchdEnv>;
beforeEach(() => {
  env = createDefaultLaunchdEnv();
});

describe("LaunchAgent service membership", () => {
  beforeEach(() => vi.stubEnv("LAUNCH_JOB_LABEL", "ai.openclaw.gateway"));
  const restart = () => restartLaunchAgent(launchAgentControlFixture(env));
  it("restarts from a verified external terminal with unreadable ancestors", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set(launchdCallerPids));

    await expect(restart()).resolves.toEqual({ outcome: "completed" });
    expectCalls(["print"], ["enable"], ["kickstart", "-k"]);
    expect(handoff).not.toHaveBeenCalled();
  });

  it.each([
    ["synchronous", { ok: false, error: "spawn failed" }, "spawn failed"],
    ["asynchronous", { ok: true, value: Promise.resolve(false) }, "helper failed to spawn"],
  ] as const)("surfaces %s detached handoff failures", async (_failure, result, reason) => {
    const stdout = new PassThrough();
    const onMutation = vi.fn();
    nativeServiceMembership.mockReturnValue("inside");
    handoff.mockReturnValue(result);

    await expect(restartLaunchAgent({ env, stdout, onMutation })).rejects.toThrow(
      `launchd restart handoff failed: ${reason}`,
    );
    expect(onMutation).not.toHaveBeenCalled();
    expect(stdout.read()?.toString() ?? "").not.toContain("Scheduled LaunchAgent restart");
  });

  it.each([
    { action: "install", membership: "inside" },
    { action: "install", membership: "unknown" },
    { action: "uninstall", membership: "ancestor" },
  ] as const)(
    "refuses $action before mutation with $membership service membership",
    async ({ action, membership }) => {
      state.serviceStates.set(serviceId, "running");
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
      const args = { ...launchAgentControlFixture(env), programArguments: defaultProgramArguments };
      await expect(
        action === "install" ? installLaunchAgent(args) : uninstallLaunchAgent(args),
      ).rejects.toThrow(
        membership === "unknown"
          ? "Native Gateway service membership could not be verified"
          : `Refusing to ${action} LaunchAgent ai.openclaw.gateway from inside ai.openclaw.gateway`,
      );
      expect(state.fileWrites).toEqual([]);
      expect(state.files.get(plistPath)).toBe(previous);
      expectCalls(["print"]);
    },
  );

  it("re-enables the LaunchAgent when the maintenance handoff cannot spawn", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    state.disableCode = 0;
    launchdRestartHandoffState.scheduleDetachedLaunchdMaintenancePark.mockReturnValueOnce({
      ok: true,
      value: Promise.resolve(false),
    });

    await expect(parkCurrentLaunchAgentForMaintenance({ env })).rejects.toThrow(
      "helper failed to spawn; restored launchd enable state",
    );
    expectCalls(["print"], ["disable"], ["enable"]);
  });

  it("hands plist reload off when current LaunchAgent needs rewritten paths", async () => {
    getSelfAndAncestorPidsSync.mockReturnValue(new Set([...launchdCallerPids, 4242]));
    const plistPath = resolveLaunchAgentPlistPath(env);
    setLegacyGatewayLaunchAgentPlist(plistPath, [
      "    <key>StandardOutPath</key>",
      "    <string>/Users/test/.openclaw-default/logs/gateway.log</string>",
    ]);

    await expect(restart()).resolves.toEqual({ outcome: "scheduled" });
    expect(handoff).toHaveBeenCalledWith({
      env,
      mode: "reload",
      waitForPid: process.pid,
    });
    expect(state.files.get(plistPath)).toContain("/Users/test/Library/Logs/openclaw/gateway.log");
    expectCalls(["print"]);
  });
});
