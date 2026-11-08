import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runNodeDaemonInstall } from "../cli/node-cli/daemon.js";
import { stageLaunchAgent } from "../daemon/launchd-install.js";
import { readLaunchAgentProgramArgumentsFromFile } from "../daemon/launchd-plist.js";
import type { GatewayServiceInstallArgs } from "../daemon/service-types.js";
import { buildSystemdUnit, parseSystemdExecStart } from "../daemon/systemd-unit.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const { serviceInstall, writeJson } = vi.hoisted(() => ({
  serviceInstall: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
  writeJson: vi.fn(),
}));
vi.mock("../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
  resolveNodeService: () => ({
    label: "Node service",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    readCommand: async () => null,
    isLoaded: async () => true,
    install: serviceInstall,
  }),
}));
vi.mock("../daemon/runtime-pin-state.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/runtime-pin-state.js")>()),
  withDaemonRuntimePinMigration: async <T>(_env: NodeJS.ProcessEnv, run: () => T) => run(),
  readDaemonRuntimePinForInstall: () => ({ revision: "empty", stored: false }),
}));
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  isSystemdUserServiceAvailable: async () => false,
}));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson, exit: vi.fn() },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const originalArgv = [...process.argv];
afterEach(() => {
  process.argv = originalArgv;
});

it.skipIf(process.platform === "win32")(
  "keeps generated node commands runnable after npm removes its exec cache",
  async () => {
    const nodePath = resolveTestNodeExecPath();
    const home = tempDirs.make("openclaw-npx-node-");
    const sourceRoot = path.join(home, ".npm", "_npx", "hash", "node_modules", "openclaw");
    const state = path.join(home, "profile-state");
    const env = {
      HOME: home,
      OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(home, "openclaw.json"),
      OPENCLAW_PROFILE: "npx-test",
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      OPENCLAW_NIX_MODE: undefined,
      OPENCLAW_WRAPPER: undefined,
    };
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
    process.argv = [nodePath, path.join(sourceRoot, "dist", "index.js")];
    const durableRoot = path.join(state, "npm", "lib", "node_modules", "openclaw");
    await fs.cp(sourceRoot, durableRoot, { recursive: true });
    await withEnvAsync(env, () =>
      runNodeDaemonInstall({
        host: "127.0.0.1",
        port: 19872,
        runtime: "node",
        runtimePath: nodePath,
        force: true,
        json: true,
      }),
    );
    const plan = serviceInstall.mock.calls[0]?.[0];
    if (!plan) {
      throw new Error("Node service was not installed");
    }
    const expectedEntrypoint = path.join(
      state,
      "npm",
      "lib",
      "node_modules",
      "openclaw",
      "openclaw.mjs",
    );
    expect(plan.programArguments[1]).toBe(expectedEntrypoint);
    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        result: "installed",
        message: expect.stringContaining(
          "npx -y openclaw@latest --profile npx-test node install --force",
        ),
      }),
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
      const launchd = await stageLaunchAgent({ ...plan, env, stdout: new PassThrough() });
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
