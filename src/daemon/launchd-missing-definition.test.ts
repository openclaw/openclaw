await vi.hoisted(() => import("./launchd-ancestry.test-support.js"));
import "./launchd-fs.mocks.test-support.js";
import { describe, expect, it, vi } from "vitest";
import { installLaunchAgent } from "./launchd-ancestry.test-support.js";
import * as launchdExec from "./launchd-exec.js";
import {
  createDefaultLaunchdEnv,
  defaultLaunchAgentFixture,
  defaultProgramArguments,
  launchAgentControlFixture,
} from "./launchd-install.test-support.js";
import { launchdTestState as state } from "./launchd-state.test-support.js";
import {
  readLaunchAgentProgramArguments,
  resolveLaunchAgentPlistPath,
  uninstallLaunchAgent,
} from "./launchd.js";

const ENV = createDefaultLaunchdEnv();
const DOMAIN = typeof process.getuid === "function" ? "gui/" + process.getuid() : "gui/501";
const ENV_FILE = "/Users/test/.openclaw/service-env/ai.openclaw.gateway.env";
const WRAPPER = "/Users/test/.openclaw/service-env/ai.openclaw.gateway-env-wrapper.sh";

describe("launchd missing definition recovery", () => {
  it("unloads a registered service even after its plist is deleted", async () => {
    const execute = launchdExec.execLaunchctl;
    using launchctl = vi.spyOn(launchdExec, "execLaunchctl");
    launchctl.mockImplementation(async (args, ...rest) =>
      args[0] === "bootout" && args.length !== 2
        ? { code: 2, stdout: "", stderr: "No such file or directory", termination: "exit" }
        : execute(args, ...rest),
    );
    state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "running");

    await uninstallLaunchAgent(launchAgentControlFixture(ENV));

    expect(state.serviceLoaded).toBe(false);
    expect(state.serviceRunning).toBe(false);
    expect(state.files.has(resolveLaunchAgentPlistPath(ENV))).toBe(false);
    expect(state.launchctlCalls).toContainEqual(["bootout", `${DOMAIN}/ai.openclaw.gateway`]);
  });

  it("replaces a loaded service after its plist is deleted", async () => {
    state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "running");
    const warn = vi.fn();

    await installLaunchAgent({ ...defaultLaunchAgentFixture(ENV), warn });

    expect(state.launchctlCalls).toContainEqual(["bootout", `${DOMAIN}/ai.openclaw.gateway`]);
    expect(await readLaunchAgentProgramArguments(ENV)).toMatchObject({
      programArguments: defaultProgramArguments,
    });
    expect(state.serviceLoaded).toBe(true);
    expect(state.serviceRunning).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plist is missing"));
  });

  it("replaces a loaded registration whose plist was deleted and restores absence on failure", async () => {
    state.serviceLoaded = false;
    state.serviceRunning = false;
    state.serviceStates.set(`${DOMAIN}/ai.openclaw.gateway`, "running");
    state.bootstrapError = "Operation not permitted";
    state.bootstrapTransient = true;
    const warn = vi.fn();

    await expect(
      installLaunchAgent({
        ...defaultLaunchAgentFixture(ENV, { environment: { OPENCLAW_GATEWAY_PORT: "19000" } }),
        warn,
      }),
    ).rejects.toThrow("launchctl bootstrap failed: Operation not permitted");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("plist is missing"));
    for (const path of [resolveLaunchAgentPlistPath(ENV), ENV_FILE, WRAPPER]) {
      expect(state.files.has(path)).toBe(false);
    }
    expect(state.serviceLoaded).toBe(false);
    expect(state.serviceRunning).toBe(false);
    expect(state.launchctlCalls.map(([command]) => command ?? "")).toEqual([
      "print",
      "print",
      "bootout",
      "enable",
      "bootstrap",
      "print",
      "bootout",
    ]);
  });
});
