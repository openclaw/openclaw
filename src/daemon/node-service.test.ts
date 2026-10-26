import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { decodeLaunchAgentPlistFixture } from "./launchd-plist.test-support.js";
import { resolveNodeService } from "./node-service.js";
import { withDaemonRuntimePinMigration } from "./runtime-pin-state.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import * as systemd from "./systemd.js";

vi.mock("./systemd.js", async (original) => ({
  ...(await original<typeof import("./systemd.js")>()),
  stageSystemdService: vi.fn(async () => {}),
  installSystemdService: vi.fn(async () => {}),
  uninstallSystemdService: vi.fn(async () => {}),
  startSystemdService: vi.fn(async () => {}),
  stopSystemdService: vi.fn(async () => {}),
  restartSystemdService: vi.fn(async () => ({ outcome: "completed" as const })),
}));

vi.mock("./launchd-system.js", async (original) => ({
  ...(await original<typeof import("./launchd-system.js")>()),
  assertNoSystemLaunchDaemonOwnership: async () => {},
}));
vi.mock("./launchd-exec.js", async (original) => ({
  ...(await original<typeof import("./launchd-exec.js")>()),
  execLaunchctl: async () => nativeExit("", "Could not find service", 113),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const actions = ["stage", "install", "uninstall", "start", "stop", "restart"] as const;
const programArguments = ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "node", "run"];
async function withNodeHome(platform: "linux" | "darwin", run: (home: string) => Promise<void>) {
  const home = dirs.make("openclaw-node-");
  const env = createPathResolutionEnv(home, {
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_PROFILE: undefined,
  });
  await withEnvAsync(env, async () => {
    // Create private stores on the real host before selecting the native adapter.
    await withDaemonRuntimePinMigration(process.env, () => undefined);
    await withMockedPlatform(platform, () => run(home));
  });
}
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("preserves a legacy Gateway definition at a profile's node service name", async () => {
  await withNodeHome("linux", async (home) => {
    const unit = path.join(home, ".config/systemd/user/openclaw-node-work.service");
    await fs.mkdir(path.dirname(unit), { recursive: true });
    const definition =
      '[Service]\nExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs gateway run\nEnvironment="OPENCLAW_PROFILE=node-work" "OPENCLAW_SERVICE_KIND=gateway"\n';
    const service = resolveNodeService();
    const args = {
      env: { ...process.env, OPENCLAW_PROFILE: "work" },
      stdout: new PassThrough(),
      programArguments,
    };
    for (const marker of [' "OPENCLAW_SERVICE_KIND=gateway"', ""]) {
      await fs.writeFile(unit, definition.replace(' "OPENCLAW_SERVICE_KIND=gateway"', marker));
      for (const action of actions) {
        await expect(service[action](args)).rejects.toThrow("not an OpenClaw node service");
      }
      await expect(fs.readFile(unit, "utf8")).resolves.toBe(
        definition.replace(' "OPENCLAW_SERVICE_KIND=gateway"', marker),
      );
    }
    for (const action of actions) {
      expect(systemd[`${action}SystemdService`]).not.toHaveBeenCalled();
    }
    await fs.writeFile(
      unit,
      definition.replace("OPENCLAW_SERVICE_KIND=gateway", "OPENCLAW_SERVICE_KIND=node"),
    );
    await service.stop(args);
    expect(systemd.stopSystemdService).toHaveBeenCalledOnce();
  });
});

it("stages and reads separate node definitions for two profiles beside the default", async () => {
  // Keep real plist/env-file reads; Linux hosts do not provide native plutil.
  vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
    if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
      throw new Error(`Unexpected native command: ${file}`);
    }
    return decodeLaunchAgentPlistFixture(options.input, args[1]);
  });
  await withNodeHome("darwin", async (home) => {
    const service = resolveNodeService();
    for (const profile of [undefined, "work", "other"]) {
      const env = { ...process.env, OPENCLAW_PROFILE: profile };
      await service.stage({
        env,
        environment: { HOME: home },
        stdout: new PassThrough(),
        programArguments,
      });
    }
    for (const profile of [undefined, "work", "other"]) {
      const label = profile ? `ai.openclaw.node.${profile}` : "ai.openclaw.node";
      const file = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
      await expect(fs.readFile(file, "utf8")).resolves.toContain(`<string>${label}</string>`);
      const command = await service.readCommand({ ...process.env, OPENCLAW_PROFILE: profile });
      expect(command).toMatchObject({
        sourcePath: file,
        environment: { OPENCLAW_LAUNCHD_LABEL: label },
      });
      expect(command?.environment?.OPENCLAW_PROFILE).toBe(profile);
    }
  });
});
