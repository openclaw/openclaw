// Write Cli Startup Metadata tests cover write cli startup metadata script behavior.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import { testing } from "../../scripts/write-cli-startup-metadata.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import { waitForChildClose, waitForPidFile } from "../helpers/process-wait.js";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// These subprocess tests use explicit ready/close signals; timeout only catches broken fixtures.
const LOAD_SENSITIVE_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;
const metadataUrl = resolveRuntimeWorkerUrl(scriptProcessEntrypoints.cliStartupMetadata);
const COMMAND_HELP_RENDER_CONCURRENCY = 2;
const DEFAULT_COMMAND_HELP_NAMES = [
  "browser",
  "secrets",
  "nodes",
  "config",
  "doctor",
  "gateway",
  "models",
  "plugins",
  "sessions",
  "tasks",
] as const;

function writeFixtureFile(rootDir: string, relativePath: string, contents: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function writeStartupMetadataSourceSignatureFixture(rootDir: string): void {
  const fixtures = new Map<string, string>([
    ["extensions/browser/src/cli/browser-cli.ts", "export const browserHelp = 'browser';\n"],
    ["extensions/canvas/cli-metadata.ts", "export const canvasMetadata = 'canvas';\n"],
    ["extensions/canvas/index.ts", "export const canvasEntry = 'canvas';\n"],
    ["extensions/canvas/src/cli.ts", "export const canvasCliHelp = 'canvas';\n"],
    ["src/cli/banner.ts", "export const banner = 'openclaw';\n"],
    [
      "src/cli/daemon-cli/register-service-commands.ts",
      "export const gatewayServiceCommands = 'gateway';\n",
    ],
    ["src/cli/gateway-cli.ts", "export const gatewayHelp = 'gateway';\n"],
    ["src/cli/gateway-cli/register.ts", "export const gatewayRegister = 'gateway';\n"],
    ["src/cli/gateway-cli/run-command.ts", "export const gatewayRun = 'gateway';\n"],
    ["src/cli/help-format.ts", "export const helpFormat = 'help';\n"],
    ["src/cli/config-cli.ts", "export const configHelp = 'config';\n"],
    ["src/cli/models-cli.ts", "export const modelsHelp = 'models';\n"],
    ["src/cli/nodes-cli/register.ts", "export const nodesHelp = 'nodes';\n"],
    ["src/cli/program/register.maintenance.ts", "export const maintenanceHelp = 'maintenance';\n"],
    [
      "src/cli/program/register.status-health-sessions.ts",
      "export const statusHealthSessionsHelp = 'sessions';\n",
    ],
    ["src/cli/program/context.ts", "export const context = 'context';\n"],
    ["src/cli/program/help.ts", "export const help = 'help';\n"],
    ["src/cli/plugins-cli.ts", "export const pluginsHelp = 'plugins';\n"],
    [
      "src/plugins/register-plugin-cli-command-groups.ts",
      "export const pluginCommandGroups = 'plugins';\n",
    ],
    ["src/cli/secrets-cli.ts", "export const secretsHelp = 'secrets';\n"],
    ["packages/terminal-core/src/links.ts", "export const links = 'links';\n"],
    ["packages/terminal-core/src/theme.ts", "export const theme = 'theme';\n"],
  ]);
  for (const [relativePath, contents] of fixtures) {
    writeFixtureFile(rootDir, relativePath, contents);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function createSpawnTextChild() {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
    stderr: new PassThrough(),
    stdout: new PassThrough(),
  });
}

async function waitForProcessExit(
  pid: number,
  timeoutMs = LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`process ${pid} was still alive after ${timeoutMs}ms`);
}

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  it("renders source root help without blocking sibling child events", async () => {
    const child = createSpawnTextChild();
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    let siblingEventObserved = false;
    const siblingEvent = new Promise<void>((resolve) => {
      setImmediate(() => {
        siblingEventObserved = true;
        resolve();
      });
    });

    const render = testing.renderSourceRootHelpText();
    child.stdout.write("Usage: openclaw\n");
    setImmediate(() => {
      child.emit("close", 0, null);
    });

    await siblingEvent;
    expect(siblingEventObserved).toBe(true);
    await expect(render).resolves.toBe("Usage: openclaw\n");
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[1]).toEqual([
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      expect.any(String),
    ]);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("finishes root help before rendering at most two command snapshots", async () => {
    const actualSpawn = (
      await vi.importActual<typeof import("node:child_process")>("node:child_process")
    ).spawn;
    const spawnMock = vi.mocked(spawn);
    const tempRoot = createTempDir("openclaw-startup-metadata-scheduling-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const startedCommands: string[] = [];
    let activeCommands = 0;
    let maxActiveCommands = 0;
    let writePromise: Promise<void> | undefined;
    let releaseRootHelp = () => {};
    let reportRootHelpStarted = () => {};
    const rootHelpStarted = new Promise<void>((resolve) => {
      reportRootHelpStarted = resolve;
    });
    const rootHelpBlocked = new Promise<void>((resolve) => {
      releaseRootHelp = resolve;
    });

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    spawnMock.mockImplementation((_command, args) => {
      const commandName = String(args[1]);
      const child = createSpawnTextChild();
      startedCommands.push(commandName);
      activeCommands += 1;
      maxActiveCommands = Math.max(maxActiveCommands, activeCommands);
      setImmediate(() => {
        child.stdout.write(`Usage: openclaw ${commandName}\n`);
        activeCommands -= 1;
        child.emit("close", 0, null);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });

    try {
      writePromise = testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => {
          reportRootHelpStarted();
          await rootHelpBlocked;
          return "Usage: openclaw\n";
        },
      });

      await rootHelpStarted;
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(startedCommands).toEqual([]);

      releaseRootHelp();
      await writePromise;

      expect(startedCommands).toEqual(DEFAULT_COMMAND_HELP_NAMES);
      expect(maxActiveCommands).toBe(COMMAND_HELP_RENDER_CONCURRENCY);
    } finally {
      releaseRootHelp();
      await writePromise?.catch(() => {});
      spawnMock.mockImplementation(actualSpawn);
    }
  });

  it("fails command help rendering when captured output exceeds the byte limit", async () => {
    await expect(
      testing.spawnText(["--eval", "process.stdout.write('x'.repeat(2048))"], {
        cwd: process.cwd(),
        env: process.env,
        failureMessage: "render failed",
        killGraceMs: 25,
        maxOutputBytes: 1024,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("render failed: output exceeded 1024 bytes");
  });

  it.each(["stdout", "stderr"] as const)(
    "fails command help rendering when %s emits a stream error",
    async (streamName) => {
      const child = createSpawnTextChild();
      const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
      const streamError = new Error(`${streamName} pipe failed`);

      const render = testing.spawnText(["--help"], {
        cwd: process.cwd(),
        env: process.env,
        failureMessage: "render failed",
        killGraceMs: 25,
        maxOutputBytes: 1024,
        spawnProcess: spawnProcess as typeof spawn,
        timeoutMs: 5_000,
      });

      child[streamName].emit("error", streamError);
      child.emit("close", null, "SIGTERM");

      await expect(render).rejects.toMatchObject({
        message: expect.stringContaining(
          `render failed: ${streamName} read error: ${streamName} pipe failed`,
        ),
        cause: streamError,
      });
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    },
  );

  it("preserves an output-limit failure when shutdown also errors a stream", async () => {
    const child = createSpawnTextChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
    const render = testing.spawnText(["--help"], {
      cwd: process.cwd(),
      env: process.env,
      failureMessage: "render failed",
      killGraceMs: 25,
      maxOutputBytes: 5,
      spawnProcess: spawnProcess as typeof spawn,
      timeoutMs: 5_000,
    });

    child.stdout.emit("data", "123456");
    child.stdout.emit("error", new Error("pipe closed during shutdown"));
    child.emit("close", null, "SIGTERM");

    await expect(render).rejects.toThrow("render failed: output exceeded 5 bytes");
  });

  it("aborts and drains the default command batch before removing shared state", async () => {
    const actualSpawn = (
      await vi.importActual<typeof import("node:child_process")>("node:child_process")
    ).spawn;
    const spawnMock = vi.mocked(spawn);
    const tempRoot = createTempDir("openclaw-startup-metadata-batch-failure-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const events: string[] = [];
    const children: Array<ReturnType<typeof createSpawnTextChild> & { commandName: string }> = [];
    const realRmSync = fs.rmSync.bind(fs);
    const removeState = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      events.push("cleanup");
      return realRmSync(target, options);
    });

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    spawnMock.mockImplementation((_command, args) => {
      const commandName = String(args[1]);
      const child = Object.assign(createSpawnTextChild(), { commandName });
      child.kill.mockImplementation((signal) => {
        events.push(`kill:${commandName}:${signal}`);
        queueMicrotask(() => {
          events.push(`close:${commandName}`);
          child.emit("close", null, signal);
        });
        return true;
      });
      children.push(child);
      return child as unknown as ReturnType<typeof spawn>;
    });

    try {
      const writePromise = testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => "Usage: openclaw\n",
      });
      const deadline = Date.now() + 1_000;
      while (children.length < COMMAND_HELP_RENDER_CONCURRENCY && Date.now() < deadline) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
      }
      expect(children.map((child) => child.commandName)).toEqual(
        DEFAULT_COMMAND_HELP_NAMES.slice(0, COMMAND_HELP_RENDER_CONCURRENCY),
      );

      const browser = children[0];
      expect(browser).toBeDefined();
      browser?.stderr.write("browser renderer failed\n");
      browser?.emit("close", 7, null);

      const error = await writePromise.then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Failed to render source browser help");
      expect((error as Error).message).toContain("browser renderer failed");
      expect((error as Error).message).toMatch(/browser renderer failed \(elapsed \d+ms\)/u);
      expect(children.map((child) => child.commandName)).not.toContain("tasks");
      for (const child of children.slice(1)) {
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
        expect(events).toContain(`close:${child.commandName}`);
      }
      expect(events.at(-1)).toBe("cleanup");
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      removeState.mockRestore();
      spawnMock.mockImplementation(actualSpawn);
    }
  });

  it.runIf(process.platform !== "win32")(
    "preserves shared state when a canceled process group cannot be proven dead",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-undrained-tree-");
      const distDir = path.join(tempRoot, "dist");
      const extensionsDir = path.join(tempRoot, "extensions");
      const outputPath = path.join(distDir, "cli-startup-metadata.json");
      const child = Object.assign(createSpawnTextChild(), { pid: 123 });
      const realProcessKill = process.kill.bind(process);
      const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -123) {
          return true;
        }
        return realProcessKill(pid, signal);
      });
      let renderStateDir = "";

      writeStartupMetadataSourceSignatureFixture(tempRoot);
      writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

      try {
        const writePromise = testing.writeCliStartupMetadata({
          distDir,
          outputPath,
          extensionsDir,
          sourceRootDir: tempRoot,
          renderBundledRootHelpText: async () => "Usage: openclaw\n",
          renderSourceBrowserHelpText: (renderContext, taskContext) => {
            renderStateDir = renderContext.env?.OPENCLAW_STATE_DIR ?? "";
            if (!taskContext) {
              throw new Error("missing render task context");
            }
            return testing.spawnText(["openclaw.mjs", "browser", "--help"], {
              cwd: tempRoot,
              env: process.env,
              failureMessage: "browser render failed",
              killGraceMs: 10,
              maxOutputBytes: 1024,
              onTerminalFailure: taskContext.reportFailure,
              signal: taskContext.signal,
              spawnProcess: (() => child as unknown as ReturnType<typeof spawn>) as typeof spawn,
              timeoutMs: 5_000,
            });
          },
          renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
          renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
          renderSourceSubcommandHelpTextRecord: () => ({
            config: "Usage: openclaw config\n",
            doctor: "Usage: openclaw doctor\n",
            gateway: "Usage: openclaw gateway\n",
            models: "Usage: openclaw models\n",
            plugins: "Usage: openclaw plugins\n",
            sessions: "Usage: openclaw sessions\n",
            tasks: "Usage: openclaw tasks\n",
          }),
        });
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        child.stderr.write("primary browser failure\n");
        child.emit("close", 7, null);

        const error = await writePromise.then(
          () => undefined,
          (reason: unknown) => reason,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("primary browser failure");
        expect((error as Error).message).toContain(
          `Preserved CLI startup metadata render state: ${renderStateDir}`,
        );
        expect(error).toMatchObject({
          preserveRenderState: true,
          processTreeCleanupFailure: {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
          },
        });
        expect(existsSync(renderStateDir)).toBe(true);
        expect(existsSync(outputPath)).toBe(false);
      } finally {
        processKill.mockRestore();
        if (renderStateDir) {
          fs.rmSync(renderStateDir, { force: true, recursive: true });
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "supervised exited descendant accepts stopped work without accepting live or unknown work",
    async () => {
      const { spawn: actualSpawn } =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const repoRoot = fs.realpathSync(process.cwd());
      const workerArgs = resolveRuntimeWorkerArgv(metadataUrl).slice(0, -1);
      const observerUrl = pathToFileURL(
        path.join(repoRoot, "scripts/lib/managed-child-process.mts"),
      ).href;
      const importScript = `
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
const metadataUrl = ${JSON.stringify(metadataUrl.href)};
const observerUrl = ${JSON.stringify(observerUrl)};
const { testing } = await import(metadataUrl);
const observer = await import(observerUrl);
const exports = {
  spawnText: typeof testing?.spawnText,
  writeCliStartupMetadata: typeof testing?.writeCliStartupMetadata,
  inspectManagedProcessGroup: typeof observer.inspectManagedProcessGroup,
  waitForManagedProcessGroupExit: typeof observer.waitForManagedProcessGroupExit,
};
for (const type of Object.values(exports)) assert.equal(type, "function");
const hash = (url) => crypto.createHash("sha256").update(fs.readFileSync(new URL(url))).digest("hex");
console.log("SUPERVISED_IMPORT_PREFLIGHT " + JSON.stringify({
  node: process.version, cwd: fs.realpathSync("."), metadataUrl, observerUrl,
  metadataSha256: hash(metadataUrl), observerSha256: hash(observerUrl),
  loaderPrefix: ${JSON.stringify(workerArgs)}, exports,
}));
`;
      const importRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-help-import-"));
      mkdirSync(path.join(importRoot, "home"));
      const preflight = actualSpawn(
        process.execPath,
        [...workerArgs, "--input-type=module", "--eval", importScript],
        {
          cwd: repoRoot,
          env: {
            PATH: process.env.PATH,
            HOME: path.join(importRoot, "home"),
            TMPDIR: importRoot,
            OPENCLAW_STATE_DIR: path.join(importRoot, "state"),
            OPENCLAW_CONFIG_PATH: path.join(importRoot, "state", "openclaw.json"),
            LANG: "C.UTF-8",
            CI: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let importOutput = "";
      let importError = "";
      let importFailure: string | undefined;
      let importJoined = false;
      let importKill: ReturnType<typeof setTimeout> | undefined;
      const stopImport = (reason: string) => {
        if (importFailure) {
          return;
        }
        importFailure = reason;
        preflight.kill("SIGTERM");
        importKill = setTimeout(() => preflight.kill("SIGKILL"), 2000);
      };
      const importDeadline = setTimeout(() => stopImport("import-only deadline exceeded"), 10_000);
      preflight.stdout.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(importOutput) + chunk.length <= 4096) {
          importOutput += chunk.toString();
        } else {
          stopImport("import-only stdout bound exceeded");
        }
      });
      preflight.stderr.on("data", (chunk: Buffer) => {
        if (Buffer.byteLength(importError) + chunk.length <= 4096) {
          importError += chunk.toString();
        } else {
          stopImport("import-only stderr bound exceeded");
        }
      });
      try {
        const result = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve) => {
            preflight.once("error", (error) => {
              importFailure = error.message;
            });
            preflight.once("close", (code, signal) => {
              importJoined = true;
              resolve({ code, signal });
            });
          },
        );
        expect(
          importFailure,
          "import-only gate precedes every process-tree fixture",
        ).toBeUndefined();
        expect(result, importError).toEqual({ code: 0, signal: null });
        expect(importOutput).toContain("SUPERVISED_IMPORT_PREFLIGHT ");
        console.log(importOutput.trim());
      } finally {
        clearTimeout(importDeadline);
        clearTimeout(importKill);
        if (importJoined) {
          fs.rmSync(importRoot, { recursive: true, force: true });
        }
      }
      const actor = String.raw`
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
const [root, role] = process.argv.slice(2);
const file = (name) => path.join(root, name);
const publish = (name, value) => {
  const temporary = file(name + ".tmp");
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file(name));
};
const wait = async (name, timeout = 5000) => {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(file(name))) {
    if (fs.existsSync(file("stop"))) process.exit(2);
    if (Date.now() >= deadline) throw new Error("fixture gate deadline: " + name);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (fs.existsSync(file("stop"))) process.exit(2);
};
publish(role + ".ready", { pid: process.pid });
if (role === "leaf") {
  await wait("leaf.exit", 45000);
} else {
  await wait(role + ".go");
  const childRole = role === "leader" ? "forker" : "leaf";
  const child = spawn(process.execPath, [process.argv[1], root, childRole], {
    stdio: "ignore", env: process.env,
  });
  if (role === "forker") {
    child.unref();
    await wait("forker.exit");
  } else {
    const joined = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    publish("forker.joined", joined);
    await wait("leader.exit", 45000);
    process.stdout.write("Usage: openclaw nodes\n");
  }
}
`;
      const controller = String.raw`
import fs from "node:fs";
import path from "node:path";
import childProcess, { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
const [root, mode, repo] = process.argv.slice(2);
let ownedLeaderPid, completedPsFault;
const originalSpawnSync = childProcess.spawnSync;
if (mode === "unknown") {
  childProcess.spawnSync = function (...args) {
    const result = Reflect.apply(originalSpawnSync, this, args);
    const [command, argv] = args;
    if (command === "ps" && ownedLeaderPid !== undefined && Array.isArray(argv) &&
        argv.length === 5 && argv[0] === "-s" && argv[1] === String(ownedLeaderPid) &&
        argv[2] === "-L" && argv[3] === "-o" && argv[4] === "pgid=,state=" &&
        result.status === 23 && result.signal === null && !result.error) {
      completedPsFault ??= { groupPid: ownedLeaderPid, status: result.status,
        signal: result.signal, errorPresent: !!result.error };
    }
    return result;
  };
  syncBuiltinESMExports();
}
const { testing } = await import(${JSON.stringify(metadataUrl.href)});
const { inspectManagedProcessGroup, waitForManagedProcessGroupExit } =
  await import(pathToFileURL(path.join(repo, "scripts/lib/managed-child-process.mts")));
const file = (name) => path.join(root, name);
const publish = (name, value) => {
  const temporary = file(name + ".tmp");
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, file(name));
};
let renderState = "", liveControl;
const events = [];
const started = Date.now();
const outputPath = file("dist/cli-startup-metadata.json");
let outcome;
try {
  await testing.writeCliStartupMetadata({
    sourceRootDir: root, distDir: file("dist"), extensionsDir: file("extensions"), outputPath,
    renderBundledRootHelpText: () => "Usage: openclaw\n",
    renderSourceRootHelpText: () => "Usage: openclaw\n",
    renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
    renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
    renderSourceSubcommandHelpTextRecord: () => Object.fromEntries(
      ["config", "doctor", "gateway", "models", "plugins", "sessions", "tasks"]
        .map((name) => [name, "Usage: openclaw " + name + "\n"])),
    renderSourceNodesHelpText: (context, taskContext) => {
      if (!taskContext) throw new Error("missing actual supervisor task context");
      renderState = context.env.OPENCLAW_STATE_DIR;
      // Unknown mode fails every snapshot while the reaper holds the stopped group.
      return testing.spawnText([file("actor.mjs"), root, "leader"], {
        cwd: root, env: process.env, failureMessage: "supervised nodes fixture failed",
        timeoutMs: 120000, killGraceMs: mode === "unknown" ? 1000 : 5000, maxOutputBytes: 16384,
        onTerminalFailure: taskContext.reportFailure, signal: taskContext.signal,
        spawnProcess: (...args) => {
          const child = spawn(...args);
          ownedLeaderPid = child.pid;
          child.once("exit", (code, signal) => events.push({ event: "exit", code, signal }));
          child.once("close", (code, signal) => {
            events.push({ event: "close", code, signal });
            publish("leader.closed", { code, signal });
          });
          if (mode === "live") {
            liveControl = (async () => {
              const readyBy = Date.now() + 5000;
              while (!fs.existsSync(file("live-control.go"))) {
                if (Date.now() >= readyBy) throw new Error("live control setup deadline");
                await new Promise((resolve) => setTimeout(resolve, 5));
              }
              const start = Date.now();
              const deadlineAt = start + 100;
              const observation = inspectManagedProcessGroup(child, {
                deadlineAt, errorPolicy: "alive-on-eperm",
              });
              const stopped = await waitForManagedProcessGroupExit(child, 100, {
                deadlineAt, errorPolicy: "alive-on-eperm",
                clampPollToDeadline: true, pollIntervalMs: 10,
              });
              publish("live-control.json", { observation, stopped, elapsedMs: Date.now() - start });
            })();
          }
          return child;
        },
      });
    },
  });
  outcome = { ok: true, nodesHelpText: JSON.parse(fs.readFileSync(outputPath, "utf8")).nodesHelpText };
} catch (error) {
  outcome = { ok: false, code: error.code ?? null,
    cleanupCode: error.processTreeCleanupFailure?.code ?? null,
    preserveRenderState: error.preserveRenderState === true };
} finally {
  if (mode === "unknown") {
    childProcess.spawnSync = originalSpawnSync;
    syncBuiltinESMExports();
  }
}
await liveControl;
publish("outcome.json", { ...outcome, completedPsFault, events, elapsedMs: Date.now() - started,
  outputPresent: fs.existsSync(outputPath), statePresent: !!renderState && fs.existsSync(renderState) });
`;
      // The reaper owns the controller and adopted leaf. It never scans or signals unrelated PIDs.
      const reaper = String.raw`
import ctypes, errno, json, os, pathlib, select, shutil, signal, subprocess, sys, time
root, mode, node, repo, worker_json = sys.argv[1:]
root = pathlib.Path(root)
started = time.monotonic()
deadline = started + 45
registered, reaped, snapshots = {}, [], {}
controller = None
leader = None
cancelled = False
captured = bytearray()
report = {"mode": mode}
def interrupt(_signum, _frame):
    global cancelled
    cancelled = True
signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
def identity(pid):
    try:
        fields = pathlib.Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    except FileNotFoundError:
        return None
    return {"pid": pid, "state": fields[0], "ppid": int(fields[1]),
            "pgid": int(fields[2]), "sid": int(fields[3]), "start": fields[19]}
def register(pid):
    current = identity(pid)
    if current is None:
        raise RuntimeError("owned process disappeared before admission")
    previous = registered.get(pid)
    if previous is not None and previous["start"] != current["start"]:
        raise RuntimeError("owned PID identity changed")
    registered[pid] = previous or current
    if len(registered) > 64:
        raise RuntimeError("owned identity limit")
    return current
def present(pid):
    current = identity(pid)
    if current is not None and current["start"] != registered[pid]["start"]:
        raise RuntimeError("refusing recycled PID")
    return current
def group_present():
    if leader is None:
        return False
    try:
        os.killpg(leader, 0)
        return True
    except ProcessLookupError:
        return False
def read(name):
    p = root / name
    return json.loads(p.read_text()) if p.exists() else None
def gate(name):
    (root / name).touch()
def drain():
    if controller is None or controller.stdout.closed:
        return
    while select.select([controller.stdout], [], [], 0)[0]:
        data = os.read(controller.stdout.fileno(), 4096)
        if not data:
            return
        captured.extend(data)
        if len(captured) > 4096:
            raise RuntimeError("controller output limit")
def wait(predicate, seconds=5):
    stop = min(deadline, time.monotonic() + seconds)
    while True:
        drain()
        if cancelled:
            raise RuntimeError("fixture interrupted")
        value = predicate()
        if value:
            return value
        if time.monotonic() >= stop:
            raise RuntimeError("fixture handshake deadline")
        if controller is not None and controller.poll() is not None:
            raise RuntimeError("controller exited before handshake")
        time.sleep(.005)
def threads(pid):
    entries = list(pathlib.Path("/proc", str(pid), "task").iterdir())
    if not entries or len(entries) > 256:
        raise RuntimeError("thread bound")
    rows = []
    for entry in entries:
        try:
            fields = (entry / "stat").read_text().rsplit(")", 1)[1].split()
        except FileNotFoundError:
            if entry.name == str(pid):
                raise
            continue
        rows.append({"pid": pid, "tid": int(entry.name), "state": fields[0],
                     "pgid": int(fields[2]), "sid": int(fields[3])})
    if not any(row["tid"] == pid for row in rows):
        raise RuntimeError("owned process leader missing from thread snapshot")
    return sorted(rows, key=lambda r: r["tid"])
def session_rows(ps):
    raw = subprocess.run([ps, "-s", str(leader), "-L", "-o", "pid=,ppid=,pgid=,sid=,lwp=,stat="],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1, check=True)
    if len(raw.stdout) > 8192 or len(raw.stderr) > 1024:
        raise RuntimeError("ps output bound")
    rows = []
    for line in raw.stdout.decode("ascii").splitlines():
        pid, ppid, pgid, sid, tid, state = line.split()
        row = dict(zip(["pid", "ppid", "pgid", "sid", "tid"],
                       map(int, [pid, ppid, pgid, sid, tid])))
        row["state"] = state
        if row["pid"] not in registered or row["pgid"] != leader or row["sid"] != leader:
            raise RuntimeError("unexpected session member")
        present(row["pid"])
        rows.append(row)
    if not rows or len(rows) > 256:
        raise RuntimeError("session thread bound")
    return rows
def discover_owned():
    pending, seen = [os.getpid()], set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            children = pathlib.Path("/proc", str(pid), "task", str(pid), "children").read_text()
        except FileNotFoundError:
            continue
        for child in map(int, children.split()):
            if identity(child) is not None:
                register(child)
                pending.append(child)
def reap():
    while True:
        try:
            pid, status = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return True
        if pid == 0:
            return False
        reaped.append({"pid": pid, "status": status})
        if controller is not None and pid == controller.pid:
            controller.returncode = os.waitstatus_to_exitcode(status)
def signal_owned(sig):
    discover_owned()
    current = [item for pid in registered if (item := present(pid)) is not None]
    members = [item for item in current if item["pgid"] == leader and item["sid"] == leader]
    covered = set()
    if leader is not None and any(item["state"] != "Z" for item in members):
        os.killpg(leader, sig)
        covered = {item["pid"] for item in members}
    elif leader is not None and group_present() and not members:
        raise RuntimeError("group ownership no longer provable")
    for pid in registered:
        if pid in covered:
            continue
        item = present(pid)
        if item is not None and item["state"] != "Z":
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
try:
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("subreaper unavailable")
    ps = shutil.which("ps")
    if not ps or not pathlib.Path(ps).is_absolute():
        raise RuntimeError("absolute ps unavailable")
    env = dict(os.environ)
    if mode == "unknown":
        shim = root / "bin"
        shim.mkdir()
        (shim / "ps").write_text("#!/bin/sh\nexit 23\n")
        (shim / "ps").chmod(0o700)
        env["PATH"] = str(shim) + os.pathsep + env["PATH"]
    controller = subprocess.Popen([node, *json.loads(worker_json), str(root / "controller.mjs"),
                                   str(root), mode, repo], cwd=repo, env=env,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    register(controller.pid)
    leader = wait(lambda: read("leader.ready"))["pid"]
    leader_identity = register(leader)
    if leader_identity["pgid"] != leader or leader_identity["sid"] != leader:
        raise RuntimeError("renderer did not own a detached group")
    gate("leader.go")
    forker = wait(lambda: read("forker.ready"))["pid"]
    register(forker)
    gate("forker.go")
    leaf = wait(lambda: read("leaf.ready"))["pid"]
    leaf_identity = register(leaf)
    if leaf_identity["pgid"] != leader or leaf_identity["sid"] != leader:
        raise RuntimeError("leaf escaped renderer group")
    gate("forker.exit")
    joined = wait(lambda: read("forker.joined"))
    if joined != {"code": 0, "signal": None}:
        raise RuntimeError("forker was not joined successfully")
    adopted = wait(lambda: (item if (item := present(leaf)) and item["ppid"] == os.getpid() else None))
    report["adopted"] = adopted
    if mode == "live":
        gate("live-control.go")
        report["liveControl"] = wait(lambda: read("live-control.json"))
        snapshots["heldLive"] = threads(leaf)
        if any(row["state"] == "Z" for row in snapshots["heldLive"]):
            raise RuntimeError("live control leaf already exited")
    gate("leaf.exit")
    wait(lambda: all(row["state"] == "Z" for row in threads(leaf)))
    gate("leader.exit")
    report["leaderClose"] = wait(lambda: read("leader.closed"))
    snapshots["stoppedGroup"] = session_rows(ps)
    if not all(row["state"].startswith("Z") for row in snapshots["stoppedGroup"]):
        raise RuntimeError("positive boundary contains live threads")
    report["signalZeroPresent"] = group_present()
    report["outcome"] = wait(lambda: read("outcome.json"), 35)
    snapshots["terminalGroup"] = session_rows(ps)
    if not all(row["state"].startswith("Z") for row in snapshots["terminalGroup"]):
        raise RuntimeError("terminal group contains live threads")
    leaf_at_reap = present(leaf)
    if (leaf_at_reap is None or leaf_at_reap["ppid"] != os.getpid() or
            leaf_at_reap["pgid"] != leader or leaf_at_reap["sid"] != leader or
            leaf_at_reap["state"] != "Z"):
        raise RuntimeError("owned leaf identity or zombie state changed before reap")
    reaped_pid, reaped_status = os.waitpid(leaf, os.WNOHANG)
    if reaped_pid != leaf or reaped_status != 0:
        raise RuntimeError("owned leaf did not reap with status zero")
    reaped.append({"pid": reaped_pid, "status": reaped_status})
    if group_present():
        raise RuntimeError("renderer group remains after exact leaf reap")
    wait(lambda: controller.poll() is not None)
    report["controllerCode"] = controller.returncode
except BaseException as error:
    report["fixtureError"] = type(error).__name__ + ": " + str(error).replace(str(root), "<fixture>")
finally:
    cleanup_start = time.monotonic()
    cleanup_deadline = cleanup_start + 15
    gate("stop")
    for name in ["leaf.exit", "forker.exit", "leader.exit"]:
        gate(name)
    try:
        signal_owned(signal.SIGTERM)
        killed = False
        while time.monotonic() < cleanup_deadline:
            discover_owned()
            all_reaped = reap()
            remaining = [pid for pid in registered if present(pid) is not None]
            if all_reaped and not remaining and not group_present():
                break
            if not killed and time.monotonic() >= cleanup_start + 2:
                signal_owned(signal.SIGKILL)
                killed = True
            time.sleep(.005)
        remaining = [pid for pid in registered if present(pid) is not None]
        report["cleanup"] = {"joined": not remaining and not group_present() and
                             (controller is None or controller.returncode is not None),
                             "remaining": remaining, "reaped": reaped,
                             "groupPresent": group_present()}
    except BaseException as error:
        report["cleanup"] = {"joined": False, "error": type(error).__name__ + ": " + str(error)}
    if controller is not None:
        drain()
        controller.stdout.close()
    report["identities"] = list(registered.values())
    report["snapshots"] = snapshots
    report["elapsedMs"] = round((time.monotonic() - started) * 1000)
    if captured:
        report["controllerOutput"] = captured.decode("utf8", errors="replace").replace(str(root), "<fixture>")
    encoded = json.dumps(report, separators=(",", ":"))
    if len(encoded.encode()) > 5000:
        raise RuntimeError("structured evidence limit")
    print(encoded, flush=True)
`;
      type Probe = {
        mode: string;
        fixtureError?: string;
        cleanup: {
          joined: boolean;
          groupPresent: boolean;
          reaped: { pid: number; status: number }[];
        };
        adopted: { pid: number; pgid: number };
        signalZeroPresent: boolean;
        controllerCode: number;
        leaderClose: { code: number; signal: string | null };
        outcome: {
          ok: boolean;
          code?: string;
          cleanupCode?: string;
          nodesHelpText?: string;
          preserveRenderState?: boolean;
          outputPresent: boolean;
          statePresent: boolean;
          events: { event: string; code: number; signal: string | null }[];
          completedPsFault?: {
            groupPid: number;
            status: number;
            signal: string | null;
            errorPresent: boolean;
          };
        };
        liveControl?: { observation: string; stopped: boolean; elapsedMs: number };
      };
      const runProbe = async (mode: string): Promise<Probe> => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-supervised-descendant-"));
        let settled = false;
        writeStartupMetadataSourceSignatureFixture(root);
        writeFixtureFile(
          root,
          "dist/root-help-fixture.js",
          "export function outputRootHelp() {}\n",
        );
        writeFixtureFile(root, "actor.mjs", actor);
        writeFixtureFile(root, "controller.mjs", controller);
        mkdirSync(path.join(root, "home"));
        const child = actualSpawn(
          "python3",
          ["-c", reaper, root, mode, process.execPath, repoRoot, JSON.stringify(workerArgs)],
          {
            cwd: repoRoot,
            env: {
              PATH: process.env.PATH,
              HOME: path.join(root, "home"),
              TMPDIR: root,
              OPENCLAW_STATE_DIR: path.join(root, "state"),
              OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
              LANG: "C.UTF-8",
              CI: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        let overflow = false;
        const term = setTimeout(() => child.kill("SIGTERM"), 45_000);
        const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
        child.stdout.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(stdout) + chunk.length <= 16_384) {
            stdout += chunk.toString();
          } else {
            overflow = true;
            child.kill("SIGTERM");
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (Buffer.byteLength(stderr) + chunk.length <= 4096) {
            stderr += chunk.toString();
          } else {
            overflow = true;
            child.kill("SIGTERM");
          }
        });
        try {
          const closed = await new Promise<{ code: number | null; signal: string | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => resolve({ code, signal }));
            },
          );
          expect(overflow, "fixture output exceeded its bound").toBe(false);
          expect(closed, stderr).toEqual({ code: 0, signal: null });
          const evidence = JSON.parse(stdout) as Probe;
          settled = evidence.cleanup.joined;
          console.log(`SUPERVISED_EXITED_DESCENDANT ${stdout.trim()}`);
          expect(
            evidence.fixtureError,
            "fixture setup/runtime is not the intended RED",
          ).toBeUndefined();
          expect(evidence.cleanup.joined, "subreaper must join every owned child").toBe(true);
          expect(evidence.cleanup.groupPresent).toBe(false);
          expect(evidence.cleanup.reaped).toContainEqual({ pid: evidence.adopted.pid, status: 0 });
          expect(evidence.controllerCode).toBe(0);
          expect(evidence.leaderClose).toEqual({ code: 0, signal: null });
          expect(evidence.outcome.events).toEqual([
            { event: "exit", code: 0, signal: null },
            { event: "close", code: 0, signal: null },
          ]);
          expect(evidence.signalZeroPresent).toBe(true);
          return evidence;
        } finally {
          clearTimeout(term);
          clearTimeout(kill);
          // Failed settlement retains the synthetic state until the owned remote lease is stopped.
          if (settled) {
            fs.rmSync(root, { recursive: true, force: true });
          }
        }
      };
      const stopped = await runProbe("stopped");
      const live = await runProbe("live");
      expect(live.liveControl?.observation).not.toBe("dead");
      expect(live.liveControl?.stopped).toBe(false);
      expect(live.liveControl?.elapsedMs).toBeGreaterThanOrEqual(100);
      const unknown = await runProbe("unknown");
      expect(unknown.outcome).toMatchObject({
        ok: false,
        code: "EPROCESSGROUP_CLEANUP_FAILED",
        preserveRenderState: true,
        statePresent: true,
        outputPresent: false,
      });
      expect(unknown.outcome.completedPsFault).toEqual({
        groupPid: unknown.adopted.pgid,
        status: 23,
        signal: null,
        errorPresent: false,
      });
      expect(stopped.outcome, JSON.stringify(stopped.outcome)).toMatchObject({
        ok: true,
        nodesHelpText: "Usage: openclaw nodes\n",
        outputPresent: true,
        statePresent: false,
      });
    },
    185_000,
  );

  it.runIf(process.platform !== "win32")(
    "cancels a default-batch sibling process tree after another command fails",
    async () => {
      const actualSpawn = (
        await vi.importActual<typeof import("node:child_process")>("node:child_process")
      ).spawn;
      const spawnMock = vi.mocked(spawn);
      const tempRoot = createTempDir("openclaw-startup-metadata-batch-tree-");
      const distDir = path.join(tempRoot, "dist");
      const extensionsDir = path.join(tempRoot, "extensions");
      const outputPath = path.join(distDir, "cli-startup-metadata.json");
      const grandchildPidPath = path.join(tempRoot, "grandchild.pid");
      const startedCommands: string[] = [];
      const startedChildren: Array<ReturnType<typeof spawn>> = [];
      let grandchildPid = 0;

      writeStartupMetadataSourceSignatureFixture(tempRoot);
      writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

      const failingScript = [
        "const { existsSync } = await import('node:fs');",
        `const marker = ${JSON.stringify(grandchildPidPath)};`,
        "const timer = setInterval(() => {",
        "  if (!existsSync(marker)) return;",
        "  clearInterval(timer);",
        "  process.stderr.write('browser sentinel failure\\n', () => process.exit(9));",
        "}, 5);",
      ].join("\n");
      const grandchildScript = [
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const siblingScript = [
        "const { spawn } = await import('node:child_process');",
        "const { writeFileSync } = await import('node:fs');",
        `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const idleScript = [
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      spawnMock.mockImplementation((_command, args, options) => {
        const commandName = String(args[1]);
        startedCommands.push(commandName);
        const script =
          commandName === "browser"
            ? failingScript
            : commandName === "secrets"
              ? siblingScript
              : idleScript;
        const child = actualSpawn(
          process.execPath,
          ["--input-type=module", "--eval", script],
          options,
        );
        startedChildren.push(child);
        return child;
      });

      try {
        const startedAt = Date.now();
        const error = await testing
          .writeCliStartupMetadata({
            distDir,
            outputPath,
            extensionsDir,
            sourceRootDir: tempRoot,
            renderBundledRootHelpText: async () => "Usage: openclaw\n",
          })
          .then(
            () => undefined,
            (reason: unknown) => reason,
          );

        grandchildPid = await waitForPidFile(grandchildPidPath, LOAD_SENSITIVE_PROCESS_TIMEOUT_MS);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("browser sentinel failure");
        expect(Date.now() - startedAt).toBeLessThan(LOAD_SENSITIVE_PROCESS_TIMEOUT_MS);
        expect(startedCommands).toHaveLength(COMMAND_HELP_RENDER_CONCURRENCY);
        expect(startedCommands).not.toContain("tasks");
        await waitForProcessExit(grandchildPid);
        expect(existsSync(outputPath)).toBe(false);
      } finally {
        spawnMock.mockImplementation(actualSpawn);
        for (const child of startedChildren) {
          if (child.pid && processIsAlive(child.pid)) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
          }
        }
        if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {}
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "kills descendant processes when command help rendering times out",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-timeout-");
      const markerPath = path.join(tempRoot, "grandchild.pid");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = await import('node:child_process');",
        "const { writeFileSync } = await import('node:fs');",
        `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");

      await expect(
        testing.spawnText(["--input-type=module", "--eval", parentScript], {
          cwd: tempRoot,
          env: process.env,
          failureMessage: "render failed",
          killGraceMs: 25,
          maxOutputBytes: 1024,
          timeoutMs: 500,
        }),
      ).rejects.toThrow("render failed: timed out after 500ms");

      const grandchildPid = await waitForPidFile(markerPath, LOAD_SENSITIVE_PROCESS_TIMEOUT_MS);
      await waitForProcessExit(grandchildPid);
    },
  );

  it.runIf(process.platform !== "win32")(
    "drains descendants when a command leader exits nonzero",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-nonzero-tree-");
      const markerPath = path.join(tempRoot, "grandchild.pid");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const parentScript = [
        "const { spawn } = await import('node:child_process');",
        "const { writeFileSync } = await import('node:fs');",
        `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchildScript)}], { stdio: "ignore" });`,
        `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
        "process.stderr.write('leader failed\\n', () => process.exit(7));",
      ].join("\n");

      await expect(
        testing.spawnText(["--input-type=module", "--eval", parentScript], {
          cwd: tempRoot,
          env: process.env,
          failureMessage: "render failed",
          killGraceMs: 25,
          maxOutputBytes: 1024,
          timeoutMs: 5_000,
        }),
      ).rejects.toThrow(/render failed: leader failed.*elapsed \d+ms/u);

      const grandchildPid = Number(readFileSync(markerPath, "utf8"));
      await waitForProcessExit(grandchildPid);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for all command help descendants before re-raising parent signals",
    async () => {
      const tempRoot = createTempDir("openclaw-startup-metadata-signal-");
      const fastCommandPath = path.join(tempRoot, "fast-command.mjs");
      const fastReadyPath = path.join(tempRoot, "fast-ready");
      const commandPath = path.join(tempRoot, "command.mjs");
      const runnerPath = path.join(tempRoot, "runner.mjs");
      const grandchildPidPath = path.join(tempRoot, "grandchild.pid");
      const renderStatePath = path.join(tempRoot, "render-state.txt");
      const distDir = path.join(tempRoot, "dist");
      const outputPath = path.join(distDir, "cli-startup-metadata.json");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFixtureFile(
        tempRoot,
        "fast-command.mjs",
        [
          "import { writeFileSync } from 'node:fs';",
          `writeFileSync(${JSON.stringify(fastReadyPath)}, "ready");`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeFixtureFile(
        tempRoot,
        "command.mjs",
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
            grandchildScript,
          )}], { stdio: "ignore" });`,
          `writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeStartupMetadataSourceSignatureFixture(tempRoot);
      writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");
      writeFixtureFile(
        tempRoot,
        "runner.mjs",
        [
          `const { testing } = await import(${JSON.stringify(metadataUrl.href)});`,
          "const { writeFileSync } = await import('node:fs');",
          "const renderCommand = (commandPath, failureMessage) => (context, taskContext) => {",
          "  if (!taskContext) throw new Error('missing render task context');",
          `  writeFileSync(${JSON.stringify(renderStatePath)}, context.env.OPENCLAW_STATE_DIR);`,
          "  return testing.spawnText([commandPath], {",
          `    cwd: ${JSON.stringify(tempRoot)},`,
          "    env: process.env,",
          "    failureMessage,",
          "    killGraceMs: 100,",
          "    maxOutputBytes: 1024,",
          "    onTerminalFailure: taskContext.reportFailure,",
          "    signal: taskContext.signal,",
          "    timeoutMs: 30_000,",
          "  });",
          "};",
          "await testing.writeCliStartupMetadata({",
          `  distDir: ${JSON.stringify(distDir)},`,
          `  outputPath: ${JSON.stringify(outputPath)},`,
          `  extensionsDir: ${JSON.stringify(path.join(tempRoot, "extensions"))},`,
          `  sourceRootDir: ${JSON.stringify(tempRoot)},`,
          "  renderBundledRootHelpText: async () => 'Usage: openclaw\\n',",
          `  renderSourceBrowserHelpText: renderCommand(${JSON.stringify(fastCommandPath)}, 'fast render failed'),`,
          `  renderSourceSecretsHelpText: renderCommand(${JSON.stringify(commandPath)}, 'render failed'),`,
          "  renderSourceNodesHelpText: () => 'Usage: openclaw nodes\\n',",
          "  renderSourceSubcommandHelpTextRecord: () => ({",
          "    config: 'Usage: openclaw config\\n',",
          "    doctor: 'Usage: openclaw doctor\\n', gateway: 'Usage: openclaw gateway\\n',",
          "    models: 'Usage: openclaw models\\n', plugins: 'Usage: openclaw plugins\\n',",
          "    sessions: 'Usage: openclaw sessions\\n', tasks: 'Usage: openclaw tasks\\n',",
          "  }),",
          "});",
        ].join("\n"),
      );

      const runner = spawn(
        process.execPath,
        [...resolveRuntimeWorkerArgv(metadataUrl).slice(0, -1), runnerPath],
        {
          cwd: process.cwd(),
          stdio: "ignore",
        },
      );
      let grandchildPid = 0;

      try {
        const deadline = Date.now() + LOAD_SENSITIVE_PROCESS_TIMEOUT_MS;
        grandchildPid = await waitForPidFile(grandchildPidPath, LOAD_SENSITIVE_PROCESS_TIMEOUT_MS);
        while (Date.now() < deadline) {
          let fastReady = false;
          try {
            fastReady = readFileSync(fastReadyPath, "utf8") === "ready";
          } catch {}
          if (fastReady && grandchildPid > 0 && processIsAlive(grandchildPid)) {
            break;
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 10);
          });
        }
        expect(readFileSync(fastReadyPath, "utf8")).toBe("ready");
        expect(grandchildPid).toBeGreaterThan(0);
        expect(processIsAlive(grandchildPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(waitForChildClose(runner, LOAD_SENSITIVE_PROCESS_TIMEOUT_MS)).resolves.toEqual(
          {
            code: null,
            signal: "SIGTERM",
          },
        );
        await waitForProcessExit(grandchildPid);
        const renderStateDir = readFileSync(renderStatePath, "utf8");
        expect(existsSync(renderStateDir)).toBe(false);
      } finally {
        if (runner.pid && processIsAlive(runner.pid)) {
          runner.kill("SIGKILL");
        }
        if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );

  it.each(["new", "existing", "symlinked parent"] as const)(
    "writes complete startup metadata with %s output and source-rendered help",
    async (outputKind) => {
      const tempRoot = createTempDir("openclaw-startup-metadata-");
      const distDir = path.join(tempRoot, "dist");
      const outputDir =
        outputKind === "symlinked parent" ? path.join(tempRoot, "dist-link") : distDir;
      const extensionsDir = path.join(tempRoot, "extensions");
      const outputPath = path.join(outputDir, "cli-startup-metadata.json");

      mkdirSync(distDir, { recursive: true });
      if (outputKind === "symlinked parent") {
        fs.symlinkSync(distDir, outputDir, "junction");
      }
      if (outputKind === "existing") {
        writeFileSync(outputPath, '{"rootHelpText":"old help"}\n');
        fs.chmodSync(outputPath, 0o640);
      }
      fs.chmodSync(distDir, 0o750);
      mkdirSync(path.join(extensionsDir, "matrix"), { recursive: true });
      writeFileSync(
        path.join(extensionsDir, "matrix", "package.json"),
        JSON.stringify({
          openclaw: {
            channel: {
              id: "matrix",
              order: 120,
              label: "Matrix",
            },
          },
        }),
        "utf8",
      );

      await testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        renderSourceRootHelpText: () => "Usage: openclaw\n",
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
        renderSourceSubcommandHelpTextRecord: () => ({
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      });

      const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
        browserHelpText: string;
        channelOptions: string[];
        generatorSignature: string;
        nodesHelpText: string;
        rootHelpText: string;
        secretsHelpText: string;
        subcommandHelpText: {
          config: string;
          doctor: string;
          gateway: string;
          models: string;
          plugins: string;
          sessions: string;
          tasks: string;
        };
      };
      expect(written.channelOptions).toContain("matrix");
      expect(written.generatorSignature).toMatch(/^[a-f0-9]{40}$/u);
      expect(written.browserHelpText).toContain("Usage:");
      expect(written.browserHelpText).toContain("openclaw browser");
      expect(written.secretsHelpText).toContain("Usage:");
      expect(written.secretsHelpText).toContain("openclaw secrets");
      expect(written.nodesHelpText).toContain("Usage:");
      expect(written.nodesHelpText).toContain("openclaw nodes");
      expect(written.rootHelpText).toContain("Usage:");
      expect(written.rootHelpText).toContain("openclaw");
      expect(written.subcommandHelpText.config).toContain("openclaw config");
      expect(written.subcommandHelpText.doctor).toContain("openclaw doctor");
      expect(written.subcommandHelpText.gateway).toContain("openclaw gateway");
      expect(written.subcommandHelpText.models).toContain("openclaw models");
      expect(written.subcommandHelpText.plugins).toContain("openclaw plugins");
      expect(written.subcommandHelpText.sessions).toContain("openclaw sessions");
      expect(written.subcommandHelpText.tasks).toContain("openclaw tasks");
      expect(fs.readdirSync(distDir)).toEqual(["cli-startup-metadata.json"]);
      if (process.platform !== "win32") {
        expect(fs.statSync(distDir).mode & 0o777).toBe(0o750);
        expect(fs.statSync(outputPath).mode & 0o777).toBe(
          outputKind === "existing" ? 0o640 : 0o666 & ~process.umask(),
        );
      }
    },
  );

  it.each(["partial write", "rename"] as const)(
    "preserves the prior startup metadata after a failed %s",
    async (failurePhase) => {
      const tempRoot = createTempDir("openclaw-startup-metadata-publication-");
      const distDir = path.join(tempRoot, "dist");
      const outputPath = path.join(distDir, "cli-startup-metadata.json");
      writeStartupMetadataSourceSignatureFixture(tempRoot);
      mkdirSync(distDir);
      let revision = "before";
      const options = {
        distDir,
        outputPath,
        extensionsDir: path.join(tempRoot, "extensions"),
        sourceRootDir: tempRoot,
        renderSourceRootHelpText: () => `Usage: openclaw ${revision}\n`,
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
        renderSourceSubcommandHelpTextRecord: () => ({
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      };
      await testing.writeCliStartupMetadata(options);
      const previous = readFileSync(outputPath, "utf8");
      revision = "after";
      const failure = Object.assign(new Error(`publication ${failurePhase} failed`), {
        code: failurePhase === "partial write" ? "ENOSPC" : "EACCES",
      });
      const realWrite = fs.writeFileSync.bind(fs);
      const realRename = fs.renameSync.bind(fs);
      const write = vi
        .spyOn(fs, "writeFileSync")
        .mockImplementation((target, data, writeOptions) => {
          if (
            failurePhase === "partial write" &&
            typeof data === "string" &&
            data.includes('"generatedBy": "scripts/write-cli-startup-metadata.ts"')
          ) {
            realWrite(target, data.slice(0, 32), writeOptions);
            throw failure;
          }
          realWrite(target, data, writeOptions);
        });
      const rename = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        if (
          failurePhase === "rename" &&
          path.basename(String(destination)) === path.basename(outputPath)
        ) {
          throw failure;
        }
        realRename(source, destination);
      });
      try {
        syncBuiltinESMExports();
        await expect(testing.writeCliStartupMetadata(options)).rejects.toBe(failure);
        expect(readFileSync(outputPath, "utf8")).toBe(previous);
        expect(fs.readdirSync(distDir)).toEqual([path.basename(outputPath)]);
      } finally {
        write.mockRestore();
        rename.mockRestore();
        syncBuiltinESMExports();
      }
    },
  );

  it("does not source-fallback a bundled root resource failure", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-root-resource-failure-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const renderSourceRootHelpText = vi.fn(() => "Usage: source fallback\n");

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const error = await testing
      .writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => {
          throw Object.assign(new Error("bundled root timed out"), { code: "ETIMEDOUT" });
        },
        renderSourceRootHelpText,
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
        renderSourceSubcommandHelpTextRecord: () => ({
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("bundled root timed out");
    expect(renderSourceRootHelpText).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    { rendererExtension: "js", helperExtension: "mjs" },
    { rendererExtension: "mjs", helperExtension: "js" },
  ])(
    "selects the .$rendererExtension root-help renderer beside a .$helperExtension helper",
    async ({ rendererExtension, helperExtension }) => {
      const tempRoot = createTempDir("openclaw-startup-metadata-bundle-selection-");
      const distDir = path.join(tempRoot, "dist");
      const extensionsDir = path.join(tempRoot, "extensions");
      const outputPath = path.join(distDir, "cli-startup-metadata.json");
      const renderSourceRootHelpText = vi.fn(() => "Usage: source fallback\n");

      writeStartupMetadataSourceSignatureFixture(tempRoot);
      writeFixtureFile(tempRoot, "package.json", '{"type":"module"}\n');
      writeFixtureFile(
        distDir,
        `root-help-live-config-fixture.${helperExtension}`,
        "async function loadRootHelpRenderOptionsForConfigSensitivePlugins() { return null; }\nexport { loadRootHelpRenderOptionsForConfigSensitivePlugins };\n",
      );
      writeFixtureFile(
        distDir,
        `root-help-renderer-fixture.${rendererExtension}`,
        `import "./root-help-live-config-fixture.${helperExtension}";\nasync function outputRootHelp() { process.stdout.write('Usage: bundled renderer\\n'); }\nexport { outputRootHelp };\n`,
      );

      await testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderSourceRootHelpText,
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
        renderSourceSubcommandHelpTextRecord: () => ({
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      });

      const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
        rootHelpText: string;
      };
      expect(written.rootHelpText).toBe("Usage: bundled renderer\n");
      expect(renderSourceRootHelpText).not.toHaveBeenCalled();
    },
  );

  it("renders independent startup help snapshots concurrently", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-concurrency-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const started: string[] = [];
    const unblockers = new Map<string, () => void>();
    const expectedStarted = ["browser", "secrets", "nodes", "subcommands"];

    mkdirSync(distDir, { recursive: true });
    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const renderAfterUnblock = (label: string, output: string): (() => Promise<string>) => {
      return async () => {
        started.push(label);
        await new Promise<void>((resolve) => {
          unblockers.set(label, resolve);
        });
        return output;
      };
    };

    const waitForAllStarted = async (): Promise<void> => {
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        if (expectedStarted.every((label) => started.includes(label))) {
          return;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 5);
        });
      }
      throw new Error(`startup help renderers did not start concurrently: ${started.join(", ")}`);
    };

    const writePromise = testing.writeCliStartupMetadata({
      distDir,
      outputPath,
      extensionsDir,
      sourceRootDir: tempRoot,
      renderBundledRootHelpText: async () => "Usage: openclaw\n",
      renderSourceBrowserHelpText: renderAfterUnblock("browser", "Usage: openclaw browser\n"),
      renderSourceSecretsHelpText: renderAfterUnblock("secrets", "Usage: openclaw secrets\n"),
      renderSourceNodesHelpText: renderAfterUnblock("nodes", "Usage: openclaw nodes\n"),
      renderSourceSubcommandHelpTextRecord: async () => {
        started.push("subcommands");
        await new Promise<void>((resolve) => {
          unblockers.set("subcommands", resolve);
        });
        return {
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        };
      },
    });

    await waitForAllStarted();
    for (const label of expectedStarted) {
      unblockers.get(label)?.();
    }
    await writePromise;

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      browserHelpText: string;
      nodesHelpText: string;
      secretsHelpText: string;
    };
    expect(written.browserHelpText).toContain("openclaw browser");
    expect(written.secretsHelpText).toContain("openclaw secrets");
    expect(written.nodesHelpText).toContain("openclaw nodes");
  });

  it.each([
    { title: "after successful rendering", failRender: false },
    { title: "when rendering fails", failRender: true },
  ])("removes isolated root-help state $title", async ({ failRender }) => {
    const removeState = vi.spyOn(fs, "rmSync");
    const tempRoot = createTempDir("openclaw-startup-metadata-cleanup-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    let stateDir = "";
    let statePresentDuringSiblingRender = false;

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const writeMetadata = testing.writeCliStartupMetadata({
      distDir,
      outputPath,
      extensionsDir,
      sourceRootDir: tempRoot,
      renderBundledRootHelpText: async () => "Usage: openclaw\n",
      renderSourceBrowserHelpText: async (renderContext) => {
        stateDir = renderContext.env?.OPENCLAW_STATE_DIR ?? "";
        const sqliteDir = path.join(stateDir, "state");
        mkdirSync(sqliteDir, { recursive: true });
        for (const suffix of ["", "-shm", "-wal"]) {
          writeFileSync(path.join(sqliteDir, `openclaw.sqlite${suffix}`), "fixture", "utf8");
        }
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        if (failRender) {
          throw new Error("browser help failed");
        }
        return "Usage: openclaw browser\n";
      },
      renderSourceSecretsHelpText: async () => {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        statePresentDuringSiblingRender = existsSync(stateDir);
        return "Usage: openclaw secrets\n";
      },
      renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
      renderSourceSubcommandHelpTextRecord: () => ({
        config: "Usage: openclaw config\n",
        doctor: "Usage: openclaw doctor\n",
        gateway: "Usage: openclaw gateway\n",
        models: "Usage: openclaw models\n",
        plugins: "Usage: openclaw plugins\n",
        sessions: "Usage: openclaw sessions\n",
        tasks: "Usage: openclaw tasks\n",
      }),
    });

    if (failRender) {
      await expect(writeMetadata).rejects.toThrow("browser help failed");
    } else {
      await expect(writeMetadata).resolves.toBeUndefined();
    }
    expect(stateDir).not.toBe("");
    expect(statePresentDuringSiblingRender).toBe(true);
    expect(existsSync(stateDir)).toBe(false);
    expect(removeState).toHaveBeenCalledWith(stateDir, {
      force: true,
      recursive: true,
      maxRetries: 6,
      retryDelay: 25,
    });
    removeState.mockRestore();
  });

  it("does not let shared-state cleanup mask the primary render failure", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-cleanup-failure-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    const cleanupFailure = new Error("cleanup failed");
    const realRmSync = fs.rmSync.bind(fs);
    let renderStateDir = "";
    const removeState = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === renderStateDir) {
        throw cleanupFailure;
      }
      return realRmSync(target, options);
    });

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    try {
      const error = await testing
        .writeCliStartupMetadata({
          distDir,
          outputPath,
          extensionsDir,
          sourceRootDir: tempRoot,
          renderBundledRootHelpText: async () => "Usage: openclaw\n",
          renderSourceBrowserHelpText: (renderContext) => {
            renderStateDir = renderContext.env?.OPENCLAW_STATE_DIR ?? "";
            throw new Error("primary browser failure");
          },
          renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
          renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
          renderSourceSubcommandHelpTextRecord: () => ({
            config: "Usage: openclaw config\n",
            doctor: "Usage: openclaw doctor\n",
            gateway: "Usage: openclaw gateway\n",
            models: "Usage: openclaw models\n",
            plugins: "Usage: openclaw plugins\n",
            sessions: "Usage: openclaw sessions\n",
            tasks: "Usage: openclaw tasks\n",
          }),
        })
        .then(
          () => undefined,
          (reason: unknown) => reason,
        );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("primary browser failure");
      expect(error).toMatchObject({ cleanupError: cleanupFailure });
    } finally {
      removeState.mockRestore();
      if (renderStateDir) {
        realRmSync(renderStateDir, { force: true, recursive: true });
      }
    }
  });

  it("regenerates nodes help when bundled canvas CLI help sources change", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-signature-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    let nodesRenderCount = 0;

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const writeMetadata = async (): Promise<void> => {
      await testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => "Usage: openclaw\n",
        renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
        renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
        renderSourceNodesHelpText: () => {
          nodesRenderCount += 1;
          return `Usage: openclaw nodes ${nodesRenderCount}\n`;
        },
        renderSourceSubcommandHelpTextRecord: () => ({
          config: "Usage: openclaw config\n",
          doctor: "Usage: openclaw doctor\n",
          gateway: "Usage: openclaw gateway\n",
          models: "Usage: openclaw models\n",
          plugins: "Usage: openclaw plugins\n",
          sessions: "Usage: openclaw sessions\n",
          tasks: "Usage: openclaw tasks\n",
        }),
      });
    };

    await writeMetadata();
    await writeMetadata();
    expect(nodesRenderCount).toBe(1);

    const staleGeneratorMetadata = JSON.parse(readFileSync(outputPath, "utf8")) as Record<
      string,
      unknown
    >;
    staleGeneratorMetadata.generatorSignature = "stale-generator";
    writeFileSync(outputPath, `${JSON.stringify(staleGeneratorMetadata, null, 2)}\n`, "utf8");

    await writeMetadata();
    expect(nodesRenderCount).toBe(2);

    writeFixtureFile(
      tempRoot,
      "extensions/canvas/src/cli.ts",
      "export const canvasCliHelp = 'canvas changed help';\n",
    );

    await writeMetadata();

    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      nodesHelpText: string;
    };
    expect(nodesRenderCount).toBe(3);
    expect(written.nodesHelpText).toContain("openclaw nodes 3");
  });

  it("regenerates help when build version or commit changes", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-build-identity-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    let renderCount = 0;
    let commandRenderCount = 0;

    const renderSubcommandHelp = () => {
      commandRenderCount += 1;
      const buildInfo = JSON.parse(readFileSync(path.join(distDir, "build-info.json"), "utf8")) as {
        commit: string;
        version: string;
      };
      const banner = `OpenClaw ${buildInfo.version} (${buildInfo.commit.slice(0, 7)})`;
      return {
        config: `${banner}\nUsage: openclaw config\n`,
        doctor: `${banner}\nUsage: openclaw doctor\n`,
        gateway: `${banner}\nUsage: openclaw gateway\n`,
        models: `${banner}\nUsage: openclaw models\n`,
        plugins: `${banner}\nUsage: openclaw plugins\n`,
        sessions: `${banner}\nUsage: openclaw sessions\n`,
        tasks: `${banner}\nUsage: openclaw tasks\n`,
      };
    };

    writeStartupMetadataSourceSignatureFixture(tempRoot);
    writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");

    const writeMetadata = async (): Promise<void> => {
      await testing.writeCliStartupMetadata({
        distDir,
        outputPath,
        extensionsDir,
        sourceRootDir: tempRoot,
        renderBundledRootHelpText: async () => {
          renderCount += 1;
          return `Usage: openclaw ${renderCount}\n`;
        },
        renderSourceBrowserHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw browser\n";
        },
        renderSourceSecretsHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw secrets\n";
        },
        renderSourceNodesHelpText: () => {
          commandRenderCount += 1;
          return "Usage: openclaw nodes\n";
        },
        renderSourceSubcommandHelpTextRecord: renderSubcommandHelp,
      });
    };

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.2", commit: "a".repeat(40) }),
    );
    await writeMetadata();
    await writeMetadata();
    expect(renderCount).toBe(1);
    expect(commandRenderCount).toBe(4);
    expect(readFileSync(outputPath, "utf8")).toContain("OpenClaw 2026.7.2 (aaaaaaa)");

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.2", commit: "b".repeat(40) }),
    );
    await writeMetadata();
    expect(renderCount).toBe(2);
    expect(commandRenderCount).toBe(8);
    expect(readFileSync(outputPath, "utf8")).toContain("OpenClaw 2026.7.2 (bbbbbbb)");

    writeFixtureFile(
      distDir,
      "build-info.json",
      JSON.stringify({ version: "2026.7.3", commit: "b".repeat(40) }),
    );
    await writeMetadata();
    expect(renderCount).toBe(3);
    expect(commandRenderCount).toBe(12);
    const written = JSON.parse(readFileSync(outputPath, "utf8")) as {
      subcommandHelpText: { models: string };
    };
    expect(written.subcommandHelpText.models).toContain("OpenClaw 2026.7.3 (bbbbbbb)");
  });
});
