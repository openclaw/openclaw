import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { stageLaunchAgent } from "../daemon/launchd-install.js";
import { readLaunchAgentProgramArgumentsFromFile } from "../daemon/launchd-plist.js";
import { buildSystemdUnit, parseSystemdExecStart } from "../daemon/systemd-unit.js";
import { buildNodeInstallPlan } from "./node-daemon-install-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = [...process.argv];
afterEach(() => {
  process.argv = originalArgv;
});

it.skipIf(process.platform === "win32")(
  "keeps generated node commands runnable after npm removes its exec cache",
  async () => {
    const home = tempDirs.make("openclaw-npx-node-");
    const sourceRoot = path.join(home, ".npm", "_npx", "hash", "node_modules", "openclaw");
    const state = path.join(home, "profile-state");
    const env = { HOME: home, OPENCLAW_STATE_DIR: state, OPENCLAW_PROFILE: "npx-test" };
    await fs.mkdir(path.join(sourceRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.1" }),
    );
    await fs.writeFile(path.join(sourceRoot, "openclaw.mjs"), 'import "./dist/index.js";');
    await fs.writeFile(
      path.join(sourceRoot, "dist", "index.js"),
      'console.log("node service fixture");',
    );
    process.argv = [process.execPath, path.join(sourceRoot, "dist", "index.js")];
    const durableRoot = path.join(state, "npm", "lib", "node_modules", "openclaw");
    await fs.cp(sourceRoot, durableRoot, { recursive: true });
    const plan = await buildNodeInstallPlan({
      env,
      host: "127.0.0.1",
      port: 19872,
      runtime: "node",
      runtimePath: process.execPath,
      devMode: false,
    });
    const expectedEntrypoint = path.join(
      state,
      "npm",
      "lib",
      "node_modules",
      "openclaw",
      "dist",
      "index.js",
    );
    expect(plan.programArguments[1]).toBe(expectedEntrypoint);
    expect(plan.installationMessage).toContain(
      "npx -y openclaw@latest --profile npx-test node install --force",
    );
    const unit = buildSystemdUnit(plan);
    const systemdCommand = parseSystemdExecStart(
      unit
        .split("\n")
        .find((line) => line.startsWith("ExecStart="))!
        .slice("ExecStart=".length),
    );
    expect(systemdCommand).toEqual(plan.programArguments);
    const commands = [systemdCommand];
    if (process.platform === "darwin") {
      const launchd = await stageLaunchAgent({ env, stdout: new PassThrough(), ...plan });
      const launchdCommand = await readLaunchAgentProgramArgumentsFromFile(launchd.plistPath);
      if (!launchdCommand) {
        throw new Error("Could not read the generated LaunchAgent command");
      }
      expect(launchdCommand.programArguments).toEqual(plan.programArguments);
      commands.push(launchdCommand.programArguments);
    }
    await fs.rm(path.join(home, ".npm"), { recursive: true });
    for (const command of commands) {
      const [program, ...args] = command;
      if (!program) {
        throw new Error("Generated node service command has no executable");
      }
      const result = spawnSync(program, args, { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("node service fixture");
    }
  },
);
