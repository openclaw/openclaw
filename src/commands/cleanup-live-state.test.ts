import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { registerMaintenanceCommands } from "../cli/program/register.maintenance.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveGatewayService } from "../daemon/service.js";
import { mockSystemAccountHome } from "../daemon/service.test-helpers.js";
import { createNonExitingRuntime, defaultRuntime } from "../runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as cleanupUtils from "./cleanup-utils.js";

const gatewayService = vi.hoisted(() => ({
  notLoadedText: "is not installed",
  isLoaded: vi.fn(async () => false),
  isAbsent: vi.fn(async () => true),
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
vi.mock("../daemon/service.js", async () => ({
  ...(await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js")),
  resolveGatewayService: vi.fn(() => gatewayService),
}));
const { resetCommand } = await import("./reset.js");
const { uninstallCommand } = await import("./uninstall.js");

const liveOwners = new Set<ChildProcess>();
const testStates = new Set<OpenClawTestState>();
const releaseBarriers = new Set<() => void>();
const pendingCleanups = new Set<Promise<void>>();

async function stopLiveStateOwner(child: ChildProcess): Promise<void> {
  liveOwners.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error("live cleanup child did not release and exit normally");
    }
    return;
  }
  child.send?.("close");
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await once(child, "exit");
  } finally {
    clearTimeout(forceKill);
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error("live cleanup child did not release and exit normally");
  }
}

afterEach(async () => {
  for (const release of releaseBarriers) {
    release();
  }
  releaseBarriers.clear();
  const results = await Promise.allSettled(pendingCleanups);
  pendingCleanups.clear();
  results.push(...(await Promise.allSettled([...liveOwners].map(stopLiveStateOwner))));
  liveOwners.clear();
  vi.restoreAllMocks();
  results.push(...(await Promise.allSettled([...testStates].map((state) => state.cleanup()))));
  testStates.clear();
  configState.isNixMode = false;
  vi.clearAllMocks();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "live cleanup test teardown failed",
    );
  }
});

async function startLiveStateOwner(
  state: OpenClawTestState,
  contender = false,
): Promise<ChildProcess> {
  const lockModuleUrl = pathToFileURL(path.resolve("src/infra/gateway-lock.ts")).href;
  const script = `
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    const { acquireGatewayLock, GatewayLockError } = await import(${JSON.stringify(lockModuleUrl)});
    const acquire = () => acquireGatewayLock({
      allowInTests: true, env: process.env, port: 18789, timeoutMs: 250, pollIntervalMs: 25,
    });
    let lock, database;
    if (process.argv.at(-1) !== "contender") {
      lock = await acquire();
      if (!lock) throw new Error("live owner did not acquire the Gateway lock");
      const databasePath = path.join(process.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      database = new DatabaseSync(databasePath);
      database.exec("PRAGMA journal_mode = WAL; CREATE TABLE live_owner (value TEXT); INSERT INTO live_owner VALUES ('held');");
    }
    process.send?.("ready");
    process.on("message", async (message) => {
      if (message === "acquire") {
        let acquired;
        try {
          acquired = await acquire();
        } catch (error) {
          if (!(error instanceof GatewayLockError)) throw error;
          process.send?.({ acquired: false, name: error.name });
          return;
        }
        if (!acquired) throw new Error("contender did not get an ownership result");
        await acquired.release();
        process.send?.({ acquired: true });
        return;
      }
      if (message !== "close") return;
      database?.close();
      await lock?.release();
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
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
      "openclaw",
      "gateway",
      ...(contender ? ["contender"] : []),
    ],
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

function runCleanup(
  uninstall: boolean,
  runtime: ReturnType<typeof createNonExitingRuntime>,
  all = false,
) {
  const options = { yes: true, nonInteractive: true };
  return uninstall
    ? uninstallCommand(runtime, { ...options, ...(all ? { all: true } : { state: true }) })
    : resetCommand(runtime, { ...options, scope: "full" });
}

async function readFiles(paths: readonly string[]): Promise<Buffer[]> {
  return Promise.all(paths.map((filePath) => fs.readFile(filePath)));
}

it.each(["config", "credentials"] as const)(
  "holds session-scope ownership through %s removal",
  async (target) => {
    const state = await makeState();
    state.envVars.XDG_CACHE_HOME = state.path("cache");
    state.applyEnv();
    state.env.XDG_CACHE_HOME = state.path("cache");
    await state.writeConfig({ agents: { entries: { main: { workspace: state.workspaceDir } } } });
    await state.writeText("credentials/synthetic.txt", "synthetic credential");
    const contender = await startLiveStateOwner(state, true);
    const requestOwnership = async () => {
      const reply = Promise.race([
        once(contender, "message").then(([message]) => message),
        once(contender, "exit").then(([code, signal]) => {
          throw new Error(`ownership contender exited before replying (${code ?? signal})`);
        }),
      ]);
      contender.send("acquire");
      return reply;
    };
    const pathname = target === "config" ? state.configPath : state.statePath("credentials");
    const entered = createDeferred();
    const resumed = createDeferred();
    releaseBarriers.add(resumed.resolve);
    const rm = fs.rm;
    vi.spyOn(fs, "rm").mockImplementation(async (file, options) => {
      if (file === pathname) {
        entered.resolve();
        await resumed.promise;
      }
      return rm(file, options);
    });
    const cleanup = resetCommand(quietRuntime(), {
      scope: "config+creds+sessions",
      yes: true,
      nonInteractive: true,
    });
    pendingCleanups.add(cleanup);
    void cleanup.catch(() => {});
    await awaitGateBeforeSettlement(
      entered.promise,
      cleanup,
      "reset did not reach the selected removal boundary",
    );

    await expect(requestOwnership()).resolves.toMatchObject({
      acquired: false,
      name: "GatewayLockError",
    });

    resumed.resolve();
    await expect(cleanup).resolves.toBeUndefined();
    pendingCleanups.delete(cleanup);
    await expect(requestOwnership()).resolves.toEqual({ acquired: true });
    await stopLiveStateOwner(contender);
  },
);

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
  ["unmanaged reset --scope full", false, 1, false, false],
  ["Nix reset --scope full", true, 0, false, false],
  ["uninstall --state", false, 0, true, false],
  ["managerless uninstall --all", false, 0, true, true],
] as const)(
  "refuses %s until the SQLite owner exits",
  async (_command, nixMode, serviceChecks, uninstall, all) => {
    if (all) {
      mockProcessPlatform("linux");
    }
    const state = await makeState();
    configState.isNixMode = nixMode;
    const workspaceDir = uninstall && !all ? state.root : state.workspaceDir;
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
    const preservedPaths = [...livePaths, state.configPath, markerPath, profilePath, workspacePath];
    const liveBytes = await readFiles(preservedPaths);

    const blockedRuntime = quietRuntime();
    if (uninstall) {
      await expect(runCleanup(uninstall, blockedRuntime, all)).rejects.toMatchObject({
        name: "ExitError",
        code: 1,
      });
      expect(blockedRuntime.error).toHaveBeenCalledWith(
        expect.stringMatching(/Gateway|state directory/i),
      );
    } else {
      await expect(runCleanup(uninstall, blockedRuntime, all)).rejects.toThrow(
        /Gateway|state directory/i,
      );
    }
    if (!all) {
      expect(gatewayService.isLoaded).toHaveBeenCalledTimes(serviceChecks);
    }
    expect(owner.exitCode).toBeNull();
    await expect(readFiles(preservedPaths)).resolves.toEqual(liveBytes);

    await stopLiveStateOwner(owner);
    await expect(runCleanup(uninstall, quietRuntime(), all)).resolves.toBeUndefined();
    await expect(fs.readFile(profilePath, "utf8")).resolves.toBe(
      uninstall ? retainedProfile : completionHook + retainedProfile,
    );

    if (uninstall && !all) {
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

it("preserves config, credentials, and sessions when combined reset cannot acquire ownership", async () => {
  const state = await makeState();
  const credentials = await state.writeText("credentials/fixture", "synthetic credentials");
  const session = {
    agentId: "main",
    sessionKey: "agent:main:reset-fixture",
    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
  };
  const entry = { sessionId: "reset-fixture", updatedAt: Date.now() };
  await replaceSessionEntry(session, entry);
  await closeOpenClawAgentDatabaseByPathAsync(session.storePath, session.agentId);
  await fs.mkdir(state.statePath("state"), { recursive: true });
  const owner = await startLiveStateOwner(state);
  const paths = [state.configPath, credentials];
  const bytes = await readFiles(paths);

  quietRuntime(defaultRuntime);
  vi.spyOn(defaultRuntime, "exit").mockImplementation(createNonExitingRuntime().exit);
  const reset = () => {
    const program = new Command();
    registerMaintenanceCommands(program);
    return program.parseAsync(
      ["reset", "--scope", "config+creds+sessions", "--yes", "--non-interactive"],
      { from: "user" },
    );
  };

  await expect(reset()).rejects.toMatchObject({ name: "ExitError", code: 1 });
  expect(defaultRuntime.error).toHaveBeenCalledWith(
    expect.stringContaining("owns this state directory. Stop the Gateway and retry."),
  );
  expect(owner.exitCode).toBeNull();
  expect(loadSessionEntry(session)).toMatchObject(entry);
  await expect(readFiles(paths)).resolves.toEqual(bytes);

  await stopLiveStateOwner(owner);
  await reset();
  await expect(fs.access(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.access(path.dirname(credentials))).rejects.toMatchObject({ code: "ENOENT" });
  expect(loadSessionEntry(session)).toBeUndefined();
});

it("preserves a live unmanaged Gateway workspace when uninstall selects service and workspace only", async () => {
  const state = await makeState();
  await state.writeConfig({ agents: { defaults: { workspace: state.workspaceDir } } });
  await fs.mkdir(state.workspaceDir, { recursive: true });
  const marker = path.join(state.workspaceDir, "project.txt");
  await fs.writeFile(marker, "user data");
  openOpenClawStateDatabase({ env: state.env });
  const owner = await startLiveStateOwner(state);
  const runtime = quietRuntime();
  const uninstall = () =>
    uninstallCommand(runtime, {
      service: true,
      workspace: true,
      yes: true,
      nonInteractive: true,
    });

  await expect(uninstall()).rejects.toMatchObject({ name: "ExitError", code: 1 });
  await expect(fs.readFile(marker, "utf8")).resolves.toBe("user data");
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("owns this state directory"));
  await stopLiveStateOwner(owner);

  await expect(uninstall()).resolves.toBeUndefined();
  await expect(fs.access(state.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.access(state.configPath)).resolves.toBeUndefined();
});

it.skipIf(process.platform !== "linux")(
  "uninstalls state and workspace with no manager or installed service",
  async () => {
    mockSystemAccountHome();
    const state = await createOpenClawTestState({
      prefix: "openclaw-managerless-uninstall-",
      layout: "home",
      scenario: "minimal",
      applyEnv: true,
      env: {
        DBUS_SESSION_BUS_ADDRESS: undefined,
        DBUS_SYSTEM_BUS_ADDRESS: undefined,
        SYSTEMD_UNIT_PATH: undefined,
        SUDO_USER: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
      },
    });
    testStates.add(state);
    await state.writeConfig({ agents: { defaults: { workspace: state.workspaceDir } } });
    await fs.mkdir(state.workspaceDir, { recursive: true });
    await fs.writeFile(path.join(state.workspaceDir, "project.txt"), "remove selected workspace");

    // Only host service-manager files are synthetic; configuration, state ownership,
    // and selected file removal run through their real implementations.
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation((file, ...args) =>
      String(file).includes("/systemd")
        ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
        : lstat(file, ...args),
    );
    const access = fs.access;
    vi.spyOn(fs, "access").mockImplementation((file, ...args) =>
      String(file).includes("/systemd/")
        ? Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }))
        : access(file, ...args),
    );
    const readdir = fs.readdir;
    vi.spyOn(fs, "readdir").mockImplementation((file, options) =>
      String(file).includes("/systemd/")
        ? Promise.resolve([])
        : readdir(file, { ...options, recursive: false }),
    );
    const native = vi.spyOn(await import("../daemon/exec-file.js"), "execFileUtf8");
    native.mockResolvedValue({
      stdout: "",
      stderr: "busctl not found",
      code: 1,
      termination: "error",
      errorCode: "ENOENT",
    });
    const actual =
      await vi.importActual<typeof import("../daemon/service.js")>("../daemon/service.js");
    vi.mocked(resolveGatewayService).mockReturnValueOnce(actual.resolveGatewayService());
    const runtime = quietRuntime();

    const error = await runCleanup(true, runtime, true).then(
      () => null,
      (failure: unknown) => failure,
    );
    expect({ error, messages: vi.mocked(runtime.error).mock.calls }).toEqual({
      error: null,
      messages: [["No Gateway service to remove. Continuing uninstall."]],
    });

    expect(native).not.toHaveBeenCalled();
    await expect(fs.access(state.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(state.workspaceDir)).rejects.toMatchObject({ code: "ENOENT" });
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
