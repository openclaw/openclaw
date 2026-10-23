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
  execLaunchctl: async () => ({
    code: 113,
    stdout: "",
    stderr: "Could not find service",
    termination: "exit" as const,
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("preserves a legacy Gateway definition at a profile's node service name", async () => {
  const home = dirs.make("openclaw-node-collision-");
  await withEnvAsync(
    createPathResolutionEnv(home, { OPENCLAW_STATE_DIR: path.join(home, "state") }),
    async () => {
      await withDaemonRuntimePinMigration(process.env, () => undefined);
      await withMockedPlatform("linux", async () => {
        const unit = path.join(home, ".config/systemd/user/openclaw-node-work.service");
        await fs.mkdir(path.dirname(unit), { recursive: true });
        const definition =
          '[Service]\nExecStart=/usr/bin/node /opt/openclaw/openclaw.mjs gateway run\nEnvironment="OPENCLAW_PROFILE=node-work" "OPENCLAW_SERVICE_KIND=gateway"\n';
        await fs.writeFile(unit, definition);
        const service = resolveNodeService();
        const args = {
          env: { ...process.env, OPENCLAW_PROFILE: "work" },
          stdout: new PassThrough(),
          programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "node", "run"],
        };
        const effects = [
          systemd.stageSystemdService,
          systemd.installSystemdService,
          systemd.uninstallSystemdService,
          systemd.startSystemdService,
          systemd.stopSystemdService,
          systemd.restartSystemdService,
        ];
        for (const marker of [' "OPENCLAW_SERVICE_KIND=gateway"', ""]) {
          await fs.writeFile(unit, definition.replace(' "OPENCLAW_SERVICE_KIND=gateway"', marker));
          for (const action of [
            "stage",
            "install",
            "uninstall",
            "start",
            "stop",
            "restart",
          ] as const) {
            await expect(service[action](args)).rejects.toThrow("not an OpenClaw node service");
          }
          await expect(fs.readFile(unit, "utf8")).resolves.toBe(
            definition.replace(' "OPENCLAW_SERVICE_KIND=gateway"', marker),
          );
        }
        for (const effect of effects) {
          expect(effect).not.toHaveBeenCalled();
        }
        await fs.writeFile(
          unit,
          definition.replace("OPENCLAW_SERVICE_KIND=gateway", "OPENCLAW_SERVICE_KIND=node"),
        );
        await service.stop(args);
        expect(systemd.stopSystemdService).toHaveBeenCalledOnce();
      });
    },
  );
});

it("stages and reads separate node definitions for two profiles beside the default", async () => {
  // Keep real plist/env-file reads; Linux hosts do not provide native plutil.
  vi.spyOn(exec, "runExec").mockImplementation(async (file, args, options) => {
    if (file !== "/usr/bin/plutil" || typeof options !== "object" || !options.input) {
      throw new Error(`Unexpected native command: ${file}`);
    }
    return decodeLaunchAgentPlistFixture(options.input, args[1]);
  });
  const home = dirs.make("openclaw-node-profiles-");
  const isolatedEnv = createPathResolutionEnv(home, {
    OPENCLAW_STATE_DIR: path.join(home, "state"),
    OPENCLAW_PROFILE: undefined,
  });
  await withEnvAsync(isolatedEnv, async () => {
    // Create private stores on the real host before selecting the launchd adapter.
    await withDaemonRuntimePinMigration(process.env, () => undefined);
    await withMockedPlatform("darwin", async () => {
      const service = resolveNodeService();
      for (const profile of [undefined, "work", "other"]) {
        const env = { ...process.env, OPENCLAW_PROFILE: profile };
        await service.stage({
          env,
          environment: { HOME: home },
          stdout: new PassThrough(),
          programArguments: ["/usr/bin/node", "/opt/openclaw/openclaw.mjs", "node", "run"],
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
});
