await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import { expect, it, vi } from "vitest";
import { ENV, SERVICE_ID, installLaunchAgent } from "./launchd-ancestry.test-support.js";
import * as launchdExec from "./launchd-exec.js";
import {
  defaultLaunchAgentFixture,
  launchAgentControlFixture,
  defaultProgramArguments,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  readLaunchAgentProgramArguments,
  resolveLaunchAgentPlistPath,
  uninstallLaunchAgent,
} from "./launchd.js";

const PLIST = resolveLaunchAgentPlistPath(ENV);
const control = () => launchAgentControlFixture(ENV);
const install = (overrides: Parameters<typeof defaultLaunchAgentFixture>[1]) =>
  installLaunchAgent(defaultLaunchAgentFixture(ENV, overrides));

it("unloads a registered service even after its plist is deleted", async () => {
  const execute = launchdExec.execLaunchctl;
  using launchctl = vi.spyOn(launchdExec, "execLaunchctl");
  launchctl.mockImplementation(async (args, ...rest) =>
    args[0] === "bootout" && args.length !== 2
      ? { code: 2, stdout: "", stderr: "No such file or directory", termination: "exit" }
      : execute(args, ...rest),
  );

  await uninstallLaunchAgent(control());

  expect(state).toMatchObject({ serviceLoaded: false, serviceRunning: false });
  expect(state.files.has(PLIST)).toBe(false);
  expect(state.launchctlCalls).toContainEqual(["bootout", SERVICE_ID]);
});

it("replaces a loaded service after its plist is deleted", async () => {
  state.serviceStates.set(SERVICE_ID, "running");
  const warn = vi.fn();

  await install({ warn });

  expect(state.launchctlCalls).toContainEqual(["bootout", SERVICE_ID]);
  expect(await readLaunchAgentProgramArguments(ENV)).toMatchObject({
    programArguments: defaultProgramArguments,
  });
  expect(state).toMatchObject({ serviceLoaded: true, serviceRunning: true });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("plist is missing"));
});
