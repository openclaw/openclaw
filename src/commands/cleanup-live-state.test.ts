import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as cleanupUtils from "./cleanup-utils.js";

const gatewayService = vi.hoisted(() => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(async () => false),
  stop: vi.fn(async () => undefined),
  uninstall: vi.fn(async () => undefined),
}));
const configState = vi.hoisted(() => ({ isNixMode: false }));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  get isNixMode() {
    return configState.isNixMode;
  },
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => gatewayService,
}));
const { resetCommand } = await import("./reset.js");
const { uninstallCommand } = await import("./uninstall.js");

const liveOwners = new Set<ChildProcess>();
const testStates = new Set<OpenClawTestState>();

async function stopLiveStateOwner(child: ChildProcess): Promise<void> {
  liveOwners.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.send?.("close");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(forceKill);
  }
}

afterEach(async () => {
  const results = await Promise.allSettled([
    ...[...liveOwners].map((child) => stopLiveStateOwner(child)),
    ...[...testStates].map((state) => state.cleanup()),
  ]);
  liveOwners.clear();
  testStates.clear();
  configState.isNixMode = false;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "live cleanup test teardown failed",
    );
  }
});

async function startLiveStateOwner(state: OpenClawTestState): Promise<ChildProcess> {
  const lockModuleUrl = pathToFileURL(path.resolve("src/infra/gateway-lock.ts")).href;
  const script = `
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const { acquireGatewayLock } = await import(${JSON.stringify(lockModuleUrl)});
    const lock = await acquireGatewayLock({ allowInTests: true, env: process.env, port: 18789 });
    if (!lock) throw new Error("live owner did not acquire the Gateway lock");
    const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL; CREATE TABLE live_owner (value TEXT); INSERT INTO live_owner VALUES ('held');");
    process.send?.("ready");
    process.on("message", async (message) => {
      if (message !== "close") return;
      database.close();
      await lock.release().catch(() => undefined);
      process.exit(0);
    });
    setInterval(() => {}, 1_000);
  `;
  const env = { ...state.env };
  for (const key of ["NODE_ENV", "VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"]) {
    delete env[key];
  }
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script, "openclaw", "gateway"],
    { cwd: path.resolve("."), env, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  liveOwners.add(child);
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  await Promise.race([
    once(child, "message").then(([message]) => {
      if (message !== "ready") {
        throw new Error(`unexpected live owner message: ${String(message)}`);
      }
    }),
    once(child, "exit").then(([code, signal]) => {
      throw new Error(
        `live state owner exited before ready (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
      );
    }),
  ]);
  return child;
}

async function makeState(env?: NodeJS.ProcessEnv) {
  const state = await createOpenClawTestState({
    prefix: "openclaw-cleanup-",
    env,
    layout: "split",
    scenario: "minimal",
    applyEnv: true,
  });
  testStates.add(state);
  return state;
}

function quietRuntime(runtime = createNonExitingRuntime()) {
  vi.spyOn(runtime, "log").mockImplementation(() => {});
  vi.spyOn(runtime, "error").mockImplementation(() => {});
  return runtime;
}

function runCleanup(uninstall: boolean, runtime: ReturnType<typeof createNonExitingRuntime>) {
  const options = { yes: true, nonInteractive: true };
  return uninstall
    ? uninstallCommand(runtime, { ...options, state: true })
    : resetCommand(runtime, { ...options, scope: "full" });
}

async function readFiles(paths: readonly string[]): Promise<Buffer[]> {
  return Promise.all(paths.map((filePath) => fs.readFile(filePath)));
}

describe.each([
  ["reset", "--scope", "full"],
  ["uninstall", "--state", "--workspace"],
])("registered %s workspace guard", (...args) => {
  it.each([
    { agentId: "123", warningPath: 'agents.entries["123"].workspace' },
    { agentId: "constructor", warningPath: "agents.entries.constructor.workspace" },
    { agentId: "123", warningPath: undefined },
  ])("handles workspace warning $warningPath for $agentId", async ({ agentId, warningPath }) => {
    const state = await makeState({ OPENCLAW_TEST_MISSING_WORKSPACE: undefined });
    await state.writeConfig({
      ...(!warningPath
        ? { env: { vars: { constructor: "${OPENCLAW_TEST_MISSING_WORKSPACE}" } } }
        : {}),
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          [agentId]: {
            workspace: warningPath ? "${OPENCLAW_TEST_MISSING_WORKSPACE}" : state.workspaceDir,
          },
          main: { workspace: state.workspaceDir },
        },
      },
      talk: { agentId: "main" },
    });
    const removeState = vi.spyOn(cleanupUtils, "removeStateAndLinkedPaths").mockResolvedValue(true);
    const removeWorkspaces = vi.spyOn(cleanupUtils, "removeWorkspaceDirs").mockResolvedValue([]);
    const removePath = vi.spyOn(cleanupUtils, "removePath").mockResolvedValue({ ok: true });
    quietRuntime(defaultRuntime);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(createNonExitingRuntime().exit);
    const program = new Command();
    registerMaintenanceCommands(program);
    const run = program.parseAsync([...args, "--yes", "--non-interactive"], { from: "user" });

    if (warningPath) {
      await expect(run).rejects.toMatchObject({ name: "ExitError", code: 1 });
      expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(warningPath));
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("workspace configuration could not be resolved"),
      );
      expect(removeState).not.toHaveBeenCalled();
      expect(removeWorkspaces).not.toHaveBeenCalled();
    } else {
      await expect(run).resolves.toBe(program);
      expect(removeState).toHaveBeenCalledOnce();
      expect(removeWorkspaces).toHaveBeenCalledWith([state.workspaceDir], defaultRuntime, {
        dryRun: false,
        removeStateRows: false,
      });
    }
    expect(removePath).not.toHaveBeenCalled();
  });
});

it.each([
  ["unmanaged reset --scope full", false, 1, false],
  ["Nix reset --scope full", true, 0, false],
  ["uninstall --state", false, 0, true],
] as const)(
  "refuses %s until the SQLite owner exits",
  async (_command, nixMode, serviceChecks, uninstall) => {
    const state = await makeState();
    configState.isNixMode = nixMode;
    const workspaceDir = uninstall ? state.root : state.workspaceDir;
    const workspacePath = path.join(workspaceDir, "project.bin");
    await state.writeConfig({ agents: { entries: { main: { workspace: workspaceDir } } } });
    const markerPath = await state.writeText("keep.txt", "preserved");
    await fs.mkdir(path.dirname(workspacePath), { recursive: true });
    await fs.writeFile(workspacePath, Buffer.from([0, 1, 2, 3, 255]));
    const cachePath = await state.writeText("completions/openclaw.bash", "# cached completion\n");
    const profilePath = path.join(state.home, ".bashrc");
    const retainedProfile = '# User settings\r\nexport PATH="$HOME/.local/bin:$PATH"\n';
    const completionHook = `# OpenClaw Completion\nsource "${cachePath}"\n`;
    await fs.mkdir(state.home, { recursive: true });
    await fs.writeFile(profilePath, completionHook + retainedProfile);

    const databasePath = state.statePath("state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(databasePath), { recursive: true });
    const owner = await startLiveStateOwner(state);
    const livePaths = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
    const preservedPaths = [...livePaths, state.configPath, markerPath, profilePath];
    const liveBytes = await readFiles(preservedPaths);

    const blockedRuntime = quietRuntime();
    if (uninstall) {
      await expect(runCleanup(uninstall, blockedRuntime)).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      expect(blockedRuntime.error).toHaveBeenCalledWith(
        expect.stringMatching(/Gateway|state directory/i),
      );
    } else {
      await expect(runCleanup(uninstall, blockedRuntime)).rejects.toThrow(
        /Gateway|state directory/i,
      );
    }
    expect(gatewayService.isLoaded).toHaveBeenCalledTimes(serviceChecks);
    expect(owner.exitCode).toBeNull();
    await expect(readFiles(preservedPaths)).resolves.toEqual(liveBytes);

    await stopLiveStateOwner(owner);
    await expect(runCleanup(uninstall, quietRuntime())).resolves.toBeUndefined();
    await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(
      uninstall ? retainedProfile : completionHook + retainedProfile,
    );

    if (uninstall) {
      await expect(fs.readFile(workspacePath)).resolves.toEqual(Buffer.from([0, 1, 2, 3, 255]));
      for (const filePath of [markerPath, ...livePaths]) {
        await expect(fs.access(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } else {
      await expect(fs.access(state.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(fs.access(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("preserves state when workspace configuration is invalid", async () => {
  const state = await makeState();
  const workspaceDir = state.statePath("nested-workspace");
  const workspacePath = path.join(workspaceDir, "project.bin");
  const markerPath = await state.writeText("keep.txt", "preserved");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(workspacePath, Buffer.from([9, 8, 7, 6]));
  await fs.writeFile(
    state.configPath,
    `{"agents":{"entries":{"main":{"workspace":${JSON.stringify(workspaceDir)}}}`,
  );
  const preservedPaths = [markerPath, workspacePath, state.configPath];
  const preservedBytes = await readFiles(preservedPaths);
  const runtime = quietRuntime();

  await expect(runCleanup(true, runtime)).rejects.toMatchObject({ name: "ExitError", code: 1 });

  expect(runtime.error).toHaveBeenCalledWith(
    expect.stringContaining("workspace configuration could not be resolved"),
  );
  await expect(readFiles(preservedPaths)).resolves.toEqual(preservedBytes);
});
