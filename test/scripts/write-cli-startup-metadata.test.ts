import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as waitForRuntimeTick } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { scriptProcessEntrypoints } from "../../scripts/script-process-runtime.test-support.js";
import { testing } from "../../scripts/write-cli-startup-metadata.ts";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { withinTest } from "../helpers/promise.js";
import { exitedDescendantReaper } from "./exited-descendant-reaper.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn: actualSpawn } =
  await vi.importActual<typeof import("node:child_process")>("node:child_process");

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
] as const;

function sourceSubcommandHelp(banner = "") {
  const help = (name: string) => `${banner}Usage: openclaw ${name}\n`;
  return {
    config: help("config"),
    doctor: help("doctor"),
    gateway: help("gateway"),
    models: help("models"),
    plugins: help("plugins"),
    sessions: help("sessions"),
  };
}

const sourceHelpRenderers = {
  renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
  renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
  renderSourceNodesHelpText: () => "Usage: openclaw nodes\n",
  renderSourceSubcommandHelpTextRecord: () => sourceSubcommandHelp(),
};

type WrittenMetadata = {
  channelOptions: string[];
  generatorSignature: string;
  rootHelpText: string;
  browserHelpText: string;
  secretsHelpText: string;
  nodesHelpText: string;
  subcommandHelpText: ReturnType<typeof sourceSubcommandHelp>;
};
const readMetadata = (file: string): WrittenMetadata => JSON.parse(readFileSync(file, "utf8"));

function spawnHelp(
  args: string[],
  overrides: Partial<Parameters<typeof testing.spawnText>[1]> = {},
) {
  return testing.spawnText(args, {
    cwd: process.cwd(),
    env: process.env,
    failureMessage: "render failed",
    killGraceMs: 25,
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
    ...overrides,
  });
}

function descendantScript(markerPath: string, terminal: string) {
  const grandchild = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
  return [
    "const { spawn } = await import('node:child_process');",
    "const { writeFileSync } = await import('node:fs');",
    `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(grandchild)}], { stdio: "ignore" });`,
    `writeFileSync(${JSON.stringify(markerPath)}, String(grandchild.pid));`,
    terminal,
  ].join("\n");
}

function writeFixtureFile(rootDir: string, relativePath: string, contents: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

function writeStartupMetadataSourceSignatureFixture(rootDir: string): void {
  for (const relativePath of [
    "extensions/browser/src/cli/browser-cli.ts",
    "extensions/canvas/cli-metadata.ts",
    "extensions/canvas/index.ts",
    "extensions/canvas/src/cli.ts",
    "src/cli/banner.ts",
    "src/cli/gateway-cli.ts",
    "src/cli/gateway-cli/register.ts",
    "src/cli/gateway-cli/run-command.ts",
    "src/cli/help-format.ts",
    "src/cli/config-cli.ts",
    "src/cli/models-cli.ts",
    "src/cli/nodes-cli/register.ts",
    "src/cli/program/register.maintenance.ts",
    "src/cli/program/context.ts",
    "src/cli/program/help.ts",
    "src/cli/plugins-cli.ts",
    "src/cli/secrets-cli.ts",
    "packages/terminal-core/src/links.ts",
    "packages/terminal-core/src/theme.ts",
    "src/cli/daemon-cli/register-service-commands.ts",
    "src/cli/program/register.status-health-sessions.ts",
    "src/plugins/cli.ts",
  ]) {
    writeFixtureFile(rootDir, relativePath, "export {};\n");
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

function childClosed(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

// The renderer joins stopped process groups; only the OS reaper owns final PID
// disappearance, so this residual preserves the stronger absence assertion.
async function waitForProcessExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    while (processIsAlive(pid)) {
      signal.throwIfAborted();
      await waitForRuntimeTick(10, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`process ${pid} was still alive when the test aborted`, { cause: error });
    }
    throw error;
  }
}

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

describe("write-cli-startup-metadata", () => {
  const { createTempDir } = createScriptTestHarness();

  function metadataFixture(prefix: string, bundled = true) {
    const tempRoot = createTempDir(prefix);
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");
    writeStartupMetadataSourceSignatureFixture(tempRoot);
    mkdirSync(distDir, { recursive: true });
    if (bundled) {
      writeFixtureFile(distDir, "root-help-fixture.js", "export function outputRootHelp() {}\n");
    }
    return { sourceRootDir: tempRoot, distDir, extensionsDir, outputPath };
  }

  function writeWithFixtureHelp(
    metadata: ReturnType<typeof metadataFixture>,
    overrides: Partial<Parameters<typeof testing.writeCliStartupMetadata>[0]> = {},
  ) {
    return testing.writeCliStartupMetadata({
      ...metadata,
      renderBundledRootHelpText: async () => "Usage: openclaw\n",
      ...sourceHelpRenderers,
      ...overrides,
    });
  }

  it("renders source root help without blocking sibling child events", async () => {
    const child = createSpawnTextChild();
    const spawnMock = vi.mocked(spawn);
    spawnMock.mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    const siblingEvent = new Promise<void>((resolve) => {
      setImmediate(() => {
        resolve();
      });
    });

    const render = testing.renderSourceRootHelpText();
    child.stdout.write("Usage: openclaw\n");
    setImmediate(() => {
      child.emit("close", 0, null);
    });

    await siblingEvent;
    await expect(render).resolves.toBe("Usage: openclaw\n");
  });

  it("finishes root help before rendering at most two command snapshots", async () => {
    const spawnMock = vi.mocked(spawn);
    const metadata = metadataFixture("openclaw-startup-metadata-scheduling-");
    const startedCommands: string[] = [];
    let activeCommands = 0;
    let maxActiveCommands = 0;
    let writePromise: Promise<void> | undefined;
    const rootHelpStarted = Promise.withResolvers<void>();
    const rootHelpBlocked = Promise.withResolvers<void>();

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
        ...metadata,
        renderBundledRootHelpText: async () => {
          rootHelpStarted.resolve();
          await rootHelpBlocked.promise;
          return "Usage: openclaw\n";
        },
      });

      await rootHelpStarted.promise;
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      expect(startedCommands).toEqual([]);

      rootHelpBlocked.resolve();
      await writePromise;

      expect(startedCommands).toEqual(DEFAULT_COMMAND_HELP_NAMES);
      expect(maxActiveCommands).toBe(COMMAND_HELP_RENDER_CONCURRENCY);
    } finally {
      rootHelpBlocked.resolve();
      await writePromise?.catch(() => {});
      spawnMock.mockImplementation(actualSpawn);
    }
  });

  it("fails command help rendering when stderr emits a stream error", async () => {
    const streamName = "stderr";
    const child = createSpawnTextChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
    const streamError = new Error(`${streamName} pipe failed`);

    const render = spawnHelp(["--help"], {
      spawnProcess: spawnProcess as typeof spawn,
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
  });

  it("preserves an output-limit failure when shutdown also errors a stream", async () => {
    const child = createSpawnTextChild();
    const spawnProcess = vi.fn(() => child as unknown as ReturnType<typeof spawn>);
    const render = spawnHelp(["--help"], {
      maxOutputBytes: 5,
      spawnProcess: spawnProcess as typeof spawn,
    });

    child.stdout.emit("data", "123456");
    child.stdout.emit("error", new Error("pipe closed during shutdown"));
    child.emit("close", null, "SIGTERM");

    await expect(render).rejects.toThrow("render failed: output exceeded 5 bytes");
  });

  it("aborts and drains the default command batch before removing shared state", async () => {
    const spawnMock = vi.mocked(spawn);
    const metadata = metadataFixture("openclaw-startup-metadata-batch-failure-");
    const { outputPath } = metadata;
    const events: string[] = [];
    const children: Array<ReturnType<typeof createSpawnTextChild> & { commandName: string }> = [];
    const batchStarted = Promise.withResolvers<void>();
    const realRmSync = fs.rmSync.bind(fs);
    const removeState = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      events.push("cleanup");
      return realRmSync(target, options);
    });

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
      if (children.length === COMMAND_HELP_RENDER_CONCURRENCY) {
        batchStarted.resolve();
      }
      return child as unknown as ReturnType<typeof spawn>;
    });

    try {
      const writePromise = testing.writeCliStartupMetadata({
        ...metadata,
        renderBundledRootHelpText: async () => "Usage: openclaw\n",
      });
      await batchStarted.promise;
      expect(children.map((child) => child.commandName)).toEqual(
        DEFAULT_COMMAND_HELP_NAMES.slice(0, COMMAND_HELP_RENDER_CONCURRENCY),
      );

      const browser = children[0];
      expect(browser).toBeDefined();
      browser?.stderr.write("browser renderer failed\n");
      browser?.emit("close", 7, null);

      await expect(writePromise).rejects.toThrow("Failed to render source browser help");
      await expect(writePromise).rejects.toThrow(/browser renderer failed \(elapsed \d+ms\)/u);
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
      const metadata = metadataFixture("openclaw-startup-metadata-undrained-tree-");
      const { sourceRootDir: tempRoot, outputPath } = metadata;
      const child = Object.assign(createSpawnTextChild(), { pid: 123 });
      const realProcessKill = process.kill.bind(process);
      const processKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -123) {
          return true;
        }
        return realProcessKill(pid, signal);
      });
      let renderStateDir = "";

      try {
        const writePromise = writeWithFixtureHelp(metadata, {
          renderSourceBrowserHelpText: (renderContext, taskContext) => {
            renderStateDir = renderContext.env?.OPENCLAW_STATE_DIR ?? "";
            if (!taskContext) {
              throw new Error("missing render task context");
            }
            return spawnHelp(["openclaw.mjs", "browser", "--help"], {
              cwd: tempRoot,
              failureMessage: "browser render failed",
              killGraceMs: 10,
              onTerminalFailure: taskContext.reportFailure,
              signal: taskContext.signal,
              spawnProcess: (() => child as unknown as ReturnType<typeof spawn>) as typeof spawn,
            });
          },
        });
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        child.stderr.write("primary browser failure\n");
        child.emit("close", 7, null);

        await expect(writePromise).rejects.toMatchObject({
          message: expect.stringContaining("primary browser failure"),
          preserveRenderState: true,
          processTreeCleanupFailure: {
            code: "EPROCESSGROUP_CLEANUP_FAILED",
          },
        });
        await expect(writePromise).rejects.toThrow(
          `Preserved CLI startup metadata render state: ${renderStateDir}`,
        );
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
    "writes startup metadata while exited descendants await reaping",
    async () => {
      const metadata = metadataFixture("openclaw-supervised-descendant-");
      const root = metadata.sourceRootDir;
      // The child is already a zombie before help returns; no polling or release handshake.
      const actor = String.raw`
import os
leaf = os.fork()
if leaf == 0:
    os._exit(0)
exited = os.waitid(os.P_PID, leaf, os.WEXITED | os.WNOWAIT)
assert exited.si_code == os.CLD_EXITED and exited.si_status == 0
print("Usage: openclaw nodes", flush=True)
`;
      const controller = String.raw`
import assert from "node:assert/strict";
import fs from "node:fs";
import cp from "node:child_process";
import { pathToFileURL } from "node:url";
const { testing } = await import(${JSON.stringify(metadataUrl.href)});
const { assertFixtureProcessGroupStopped } = await import(pathToFileURL(
  ${JSON.stringify(path.resolve("test/scripts/exited-descendant-reaper.test-support.ts"))}
));
let child, renderState;
const events = [];
await testing.writeCliStartupMetadata({
  ...${JSON.stringify(metadata)},
  renderBundledRootHelpText: () => "Usage: openclaw\n",
  renderSourceBrowserHelpText: () => "Usage: openclaw browser\n",
  renderSourceSecretsHelpText: () => "Usage: openclaw secrets\n",
  renderSourceSubcommandHelpTextRecord: () => (${JSON.stringify(sourceSubcommandHelp())}),
  renderSourceNodesHelpText: (context, task) => {
    assert.ok(task, "missing supervisor task context");
    renderState = context.env.OPENCLAW_STATE_DIR;
    return testing.spawnText(["-c", ${JSON.stringify(actor)}], {
      cwd: ${JSON.stringify(root)}, env: process.env,
      failureMessage: "supervised nodes fixture failed",
      timeoutMs: 120000, killGraceMs: 5000, maxOutputBytes: 16384,
      onTerminalFailure: task.reportFailure, signal: task.signal,
      spawnProcess: (_node, args, options) => {
        child = cp.spawn("python3", args, options);
        for (const event of ["exit", "close"]) {
          child.once(event, (code, signal) => events.push({ event, code, signal }));
        }
        return child;
      },
    });
  },
});
assert.ok(child?.pid);
assert.doesNotThrow(() => process.kill(-child.pid, 0), "reaper must retain exited group");
assertFixtureProcessGroupStopped(child.pid);
assert.deepEqual(events, [
  { event: "exit", code: 0, signal: null }, { event: "close", code: 0, signal: null },
]);
assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(metadata.outputPath)})).nodesHelpText,
  "Usage: openclaw nodes\n");
assert.equal(fs.existsSync(renderState), false);
console.log("startup metadata verified");
`;
      const reaper = String.raw`
import os, pathlib, signal, time
owned = {}
def owned_stat(pid):
    try:
        fields = pathlib.Path("/proc", str(pid), "stat").read_text().rsplit(")", 1)[1].split()
    except (FileNotFoundError, ProcessLookupError):
        return None
    if pid in owned and owned[pid] != fields[19]:
        raise RuntimeError("refusing recycled owned PID")
    return fields
def discover_owned():
    pending, seen = [os.getpid()], set()
    while pending:
        pid = pending.pop()
        if pid in seen:
            continue
        seen.add(pid)
        try:
            children = pathlib.Path("/proc", str(pid), "task", str(pid), "children").read_text()
        except (FileNotFoundError, ProcessLookupError):
            continue
        for child in map(int, children.split()):
            fields = owned_stat(child)
            if fields is not None:
                owned[child] = fields[19]
                pending.append(child)
                if len(owned) > 64:
                    raise RuntimeError("owned identity limit")
def signal_owned(sig):
    discover_owned()
    for pid in owned:
        fields = owned_stat(pid)
        if fields is not None and fields[0] != "Z":
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
def interrupt(_signal, _frame):
    raise InterruptedError("fixture interrupted")
signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
try:
    exec(${JSON.stringify(exitedDescendantReaper)})
finally:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    started = time.monotonic()
    signal_owned(signal.SIGTERM)
    while True:
        discover_owned()
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                pid = 0
            if pid == 0:
                break
        if not any(owned_stat(pid) is not None for pid in owned):
            break
        elapsed = time.monotonic() - started
        if elapsed >= 15:
            raise RuntimeError("owned cleanup deadline")
        if elapsed >= 2:
            signal_owned(signal.SIGKILL)
        time.sleep(.005)
`;
      writeFixtureFile(root, "controller.mjs", controller);
      mkdirSync(path.join(root, "home"));
      const child = actualSpawn(
        "python3",
        [
          "-c",
          reaper,
          process.execPath,
          ...resolveRuntimeWorkerArgv(metadataUrl).slice(0, -1),
          path.join(root, "controller.mjs"),
        ],
        {
          cwd: process.cwd(),
          env: {
            PATH: process.env.PATH,
            HOME: path.join(root, "home"),
            TMPDIR: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_CONFIG_PATH: path.join(root, "state/openclaw.json"),
            LANG: "C.UTF-8",
            CI: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const term = setTimeout(() => child.kill("SIGTERM"), 45_000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 60_000);
      const output = { stdout: "", stderr: "" };
      let overflow = false;
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream].on("data", (chunk: Buffer) => {
          const limit = stream === "stdout" ? 16_384 : 4096;
          if (Buffer.byteLength(output[stream]) + chunk.length <= limit) {
            output[stream] += chunk.toString();
          } else {
            overflow = true;
            child.kill("SIGTERM");
          }
        });
      }
      try {
        expect(await childClosed(child), output.stderr).toEqual({ code: 0, signal: null });
        expect(overflow).toBe(false);
        expect(output.stdout).toContain("startup metadata verified");
        expect(output.stdout).toMatch(/successfully reaped: [1-9]/u);
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    },
    185_000,
  );

  it.runIf(process.platform !== "win32")(
    "cancels a default-batch sibling process tree after another command fails",
    async ({ signal }) => {
      const spawnMock = vi.mocked(spawn);
      const metadata = metadataFixture("openclaw-startup-metadata-batch-tree-");
      const { sourceRootDir: tempRoot, outputPath } = metadata;
      const grandchildPidPath = path.join(tempRoot, "grandchild.pid");
      const startedCommands: string[] = [];
      const startedChildren: Array<ReturnType<typeof spawn>> = [];
      let grandchildPid = 0;

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
        await expect(
          testing.writeCliStartupMetadata({
            ...metadata,
            renderBundledRootHelpText: async () => "Usage: openclaw\n",
          }),
        ).rejects.toThrow("browser sentinel failure");

        grandchildPid = Number(readFileSync(grandchildPidPath, "utf8"));
        expect(Number.isInteger(grandchildPid)).toBe(true);
        expect(grandchildPid).toBeGreaterThan(0);
        expect(Date.now() - startedAt).toBeLessThan(LOAD_SENSITIVE_PROCESS_TIMEOUT_MS);
        expect(startedCommands).toHaveLength(COMMAND_HELP_RENDER_CONCURRENCY);
        expect(startedCommands).not.toContain("tasks");
        await waitForProcessExit(grandchildPid, signal);
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

  it.runIf(process.platform !== "win32").for([
    {
      mode: "timeout",
      timeoutMs: 500,
      terminal: "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      error: "render failed: timed out after 500ms",
    },
    {
      mode: "nonzero exit",
      timeoutMs: 5_000,
      terminal: "process.stderr.write('leader failed\\n', () => process.exit(7));",
      error: /render failed: leader failed.*elapsed \d+ms/u,
    },
  ])(
    "drains descendants after command $mode",
    async ({ timeoutMs, terminal, error }, { signal }) => {
      const tempRoot = createTempDir("openclaw-startup-metadata-descendants-");
      const markerPath = path.join(tempRoot, "grandchild.pid");
      await expect(
        spawnHelp(["--input-type=module", "--eval", descendantScript(markerPath, terminal)], {
          cwd: tempRoot,
          timeoutMs,
        }),
      ).rejects.toThrow(error);
      const grandchildPid = Number(readFileSync(markerPath, "utf8"));
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(grandchildPid).toBeGreaterThan(0);
      await waitForProcessExit(grandchildPid, signal);
    },
  );

  it.runIf(process.platform !== "win32")(
    "waits for all command help descendants before re-raising parent signals",
    async ({ signal }) => {
      const {
        sourceRootDir: tempRoot,
        distDir,
        outputPath,
      } = metadataFixture("openclaw-startup-metadata-signal-");
      const fastCommandPath = path.join(tempRoot, "fast-command.mjs");
      const fastReadyPath = path.join(tempRoot, "fast-ready");
      const commandPath = path.join(tempRoot, "command.mjs");
      const runnerPath = path.join(tempRoot, "runner.mjs");
      const grandchildPidPath = path.join(tempRoot, "grandchild.pid");
      const renderStatePath = path.join(tempRoot, "render-state.txt");
      const grandchildScript = [
        "process.on('SIGTERM', () => {});",
        "process.send('ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      writeFixtureFile(
        tempRoot,
        "fast-command.mjs",
        [
          "import { writeFileSync } from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          "process.on('SIGTERM', () => process.exit(0));",
          `writeFileSync(${JSON.stringify(fastReadyPath)}, "ready");`,
          `sendReceipt(${JSON.stringify(fastReadyPath)}, "ready");`,
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
      writeFixtureFile(
        tempRoot,
        "command.mjs",
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          fixtureReceiptClientSource(receipts.endpoint),
          `const grandchild = spawn(process.execPath, ["--eval", ${JSON.stringify(
            grandchildScript,
          )}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });`,
          "process.on('SIGTERM', () => process.exit(0));",
          "grandchild.once('message', () => {",
          "  grandchild.disconnect();",
          `  writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));`,
          `  sendReceipt(${JSON.stringify(grandchildPidPath)}, "ready");`,
          "});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
      );
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
          `  renderSourceSubcommandHelpTextRecord: () => (${JSON.stringify(sourceSubcommandHelp())}),`,
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
      const closed = childClosed(runner);
      let grandchildPid = 0;
      let stopRequested = false;

      try {
        const readReadyRecords = () => {
          const pid = existsSync(grandchildPidPath)
            ? Number(readFileSync(grandchildPidPath, "utf8"))
            : Number.NaN;
          if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error(`timeout waiting for pid in ${grandchildPidPath}`);
          }
          expect(readFileSync(fastReadyPath, "utf8")).toBe("ready");
          return pid;
        };
        // Both records precede their receipts. A runner exit can overtake socket
        // delivery, so settlement checks the durable records before failing.
        grandchildPid = await withinTest(
          Promise.race([
            Promise.all([
              receipts.waitFor(grandchildPidPath, "ready"),
              receipts.waitFor(fastReadyPath, "ready"),
            ]).then(readReadyRecords),
            closed.then(readReadyRecords),
          ]),
          signal,
        );
        expect(readFileSync(fastReadyPath, "utf8")).toBe("ready");
        expect(grandchildPid).toBeGreaterThan(0);
        expect(processIsAlive(grandchildPid)).toBe(true);

        stopRequested = true;
        runner.kill("SIGTERM");

        await expect(withinTest(closed, signal)).resolves.toEqual({
          code: null,
          signal: "SIGTERM",
        });
        await waitForProcessExit(grandchildPid, signal);
        const renderStateDir = readFileSync(renderStatePath, "utf8");
        expect(existsSync(renderStateDir)).toBe(false);
      } finally {
        if (!stopRequested) {
          runner.kill("SIGTERM");
        }
        await closed;
        if (grandchildPid > 0 && processIsAlive(grandchildPid)) {
          process.kill(grandchildPid, "SIGKILL");
        }
      }
    },
  );
  it("writes complete startup metadata with existing output and source-rendered help", async () => {
    const tempRoot = createTempDir("openclaw-startup-metadata-");
    const distDir = path.join(tempRoot, "dist");
    const extensionsDir = path.join(tempRoot, "extensions");
    const outputPath = path.join(distDir, "cli-startup-metadata.json");

    mkdirSync(distDir, { recursive: true });
    writeFileSync(outputPath, '{"rootHelpText":"old help"}\n');
    fs.chmodSync(outputPath, 0o640);
    fs.chmodSync(distDir, 0o750);
    writeFixtureFile(
      extensionsDir,
      "matrix/package.json",
      JSON.stringify({ openclaw: { channel: { id: "matrix", order: 120, label: "Matrix" } } }),
    );

    await testing.writeCliStartupMetadata({
      distDir,
      outputPath,
      extensionsDir,
      renderSourceRootHelpText: () => "Usage: openclaw\n",
      ...sourceHelpRenderers,
    });

    expect(readMetadata(outputPath)).toMatchObject({
      channelOptions: expect.arrayContaining(["matrix"]),
      generatorSignature: expect.stringMatching(/^[a-f0-9]{40}$/u),
      browserHelpText: "Usage: openclaw browser\n",
      secretsHelpText: "Usage: openclaw secrets\n",
      nodesHelpText: "Usage: openclaw nodes\n",
      rootHelpText: "Usage: openclaw\n",
      subcommandHelpText: sourceSubcommandHelp(),
    });
    expect(fs.readdirSync(distDir)).toEqual(["cli-startup-metadata.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(distDir).mode & 0o777).toBe(0o750);
      expect(fs.statSync(outputPath).mode & 0o777).toBe(0o640);
    }
  });

  it.each(["partial write", "rename"] as const)(
    "preserves the prior startup metadata after a failed %s",
    async (failurePhase) => {
      const metadata = metadataFixture("openclaw-startup-metadata-publication-", false);
      const { distDir, outputPath } = metadata;
      let revision = "before";
      const options = {
        ...metadata,
        renderSourceRootHelpText: () => `Usage: openclaw ${revision}\n`,
        ...sourceHelpRenderers,
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
    const metadata = metadataFixture("openclaw-startup-metadata-root-resource-failure-");
    const { outputPath } = metadata;
    const renderSourceRootHelpText = vi.fn(() => "Usage: source fallback\n");

    await expect(
      writeWithFixtureHelp(metadata, {
        renderBundledRootHelpText: async () => {
          throw Object.assign(new Error("bundled root timed out"), { code: "ETIMEDOUT" });
        },
        renderSourceRootHelpText,
      }),
    ).rejects.toThrow("bundled root timed out");
    expect(renderSourceRootHelpText).not.toHaveBeenCalled();
    expect(existsSync(outputPath)).toBe(false);
  });

  it("selects the .mjs root-help renderer beside a .js helper", async () => {
    const metadata = metadataFixture("openclaw-startup-metadata-bundle-selection-", false);
    const { sourceRootDir: tempRoot, distDir, outputPath } = metadata;
    const renderSourceRootHelpText = vi.fn(() => "Usage: source fallback\n");

    writeFixtureFile(tempRoot, "package.json", '{"type":"module"}\n');
    writeFixtureFile(
      distDir,
      "root-help-live-config-fixture.js",
      "async function loadRootHelpRenderOptionsForConfigSensitivePlugins() { return null; }\nexport { loadRootHelpRenderOptionsForConfigSensitivePlugins };\n",
    );
    writeFixtureFile(
      distDir,
      "root-help-renderer-fixture.mjs",
      "import \"./root-help-live-config-fixture.js\";\nasync function outputRootHelp() { process.stdout.write('Usage: bundled renderer\\n'); }\nexport { outputRootHelp };\n",
    );

    await testing.writeCliStartupMetadata({
      ...metadata,
      renderSourceRootHelpText,
      ...sourceHelpRenderers,
    });

    expect(readMetadata(outputPath).rootHelpText).toBe("Usage: bundled renderer\n");
    expect(renderSourceRootHelpText).not.toHaveBeenCalled();
  });

  it("renders independent startup help snapshots concurrently", async () => {
    const metadata = metadataFixture("openclaw-startup-metadata-concurrency-");
    const { outputPath } = metadata;
    const started: string[] = [];
    const expectedStarted = ["browser", "secrets", "nodes", "subcommands"];
    const allStarted = Promise.withResolvers<void>();
    const unblocked = Promise.withResolvers<void>();
    const renderAfterUnblock =
      <T>(label: string, output: T) =>
      async () => {
        started.push(label);
        if (expectedStarted.every((name) => started.includes(name))) {
          allStarted.resolve();
        }
        await unblocked.promise;
        return output;
      };

    const writePromise = writeWithFixtureHelp(metadata, {
      renderSourceBrowserHelpText: renderAfterUnblock("browser", "Usage: openclaw browser\n"),
      renderSourceSecretsHelpText: renderAfterUnblock("secrets", "Usage: openclaw secrets\n"),
      renderSourceNodesHelpText: renderAfterUnblock("nodes", "Usage: openclaw nodes\n"),
      renderSourceSubcommandHelpTextRecord: renderAfterUnblock(
        "subcommands",
        sourceSubcommandHelp(),
      ),
    });

    await allStarted.promise;
    unblocked.resolve();
    await writePromise;

    expect(readMetadata(outputPath)).toMatchObject({
      browserHelpText: expect.stringContaining("openclaw browser"),
      secretsHelpText: expect.stringContaining("openclaw secrets"),
      nodesHelpText: expect.stringContaining("openclaw nodes"),
    });
  });

  it("does not let shared-state cleanup mask the primary render failure", async () => {
    const metadata = metadataFixture("openclaw-startup-metadata-cleanup-failure-");
    const cleanupFailure = new Error("cleanup failed");
    const realRmSync = fs.rmSync.bind(fs);
    let renderStateDir = "";
    const removeState = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      if (String(target) === renderStateDir) {
        throw cleanupFailure;
      }
      return realRmSync(target, options);
    });

    try {
      const writePromise = writeWithFixtureHelp(metadata, {
        renderSourceBrowserHelpText: (renderContext) => {
          renderStateDir = renderContext.env?.OPENCLAW_STATE_DIR ?? "";
          throw new Error("primary browser failure");
        },
      });
      await expect(writePromise).rejects.toThrow("primary browser failure");
      await expect(writePromise).rejects.toMatchObject({ cleanupError: cleanupFailure });
    } finally {
      removeState.mockRestore();
      if (renderStateDir) {
        realRmSync(renderStateDir, { force: true, recursive: true });
      }
    }
  });

  it("regenerates nodes help when canvas or plugin CLI registration sources change", async () => {
    const metadata = metadataFixture("openclaw-startup-metadata-signature-");
    const { sourceRootDir: tempRoot, outputPath } = metadata;
    let nodesRenderCount = 0;

    const writeMetadata = () =>
      writeWithFixtureHelp(metadata, {
        renderSourceNodesHelpText: () => {
          nodesRenderCount += 1;
          return `Usage: openclaw nodes ${nodesRenderCount}\n`;
        },
      });

    await writeMetadata();
    await writeMetadata();
    expect(nodesRenderCount).toBe(1);

    const staleGeneratorMetadata = readMetadata(outputPath);
    staleGeneratorMetadata.generatorSignature = "stale-generator";
    writeFileSync(outputPath, `${JSON.stringify(staleGeneratorMetadata, null, 2)}\n`, "utf8");

    await writeMetadata();
    expect(nodesRenderCount).toBe(2);

    for (const [file, contents, expectedCount] of [
      ["extensions/canvas/src/cli.ts", "export const canvasCliHelp = 'canvas changed help';\n", 3],
      ["src/plugins/cli.ts", "export const pluginCliHelp = 'changed';\n", 4],
    ] as const) {
      writeFixtureFile(tempRoot, file, contents);
      await writeMetadata();
      expect(nodesRenderCount).toBe(expectedCount);
      expect(readMetadata(outputPath).nodesHelpText).toContain(`openclaw nodes ${expectedCount}`);
    }
  });

  it("regenerates help when build version or commit changes", async () => {
    const metadata = metadataFixture("openclaw-startup-metadata-build-identity-");
    const { distDir, outputPath } = metadata;
    let renderCount = 0;
    let commandRenderCount = 0;

    const renderSubcommandHelp = () => {
      commandRenderCount += 1;
      const buildInfo = JSON.parse(readFileSync(path.join(distDir, "build-info.json"), "utf8")) as {
        commit: string;
        version: string;
      };
      const banner = `OpenClaw ${buildInfo.version} (${buildInfo.commit.slice(0, 7)})`;
      return sourceSubcommandHelp(`${banner}\n`);
    };

    const countedHelp = (command: string) => () => {
      commandRenderCount += 1;
      return `Usage: openclaw ${command}\n`;
    };
    const writeMetadata = () =>
      writeWithFixtureHelp(metadata, {
        renderBundledRootHelpText: async () => {
          renderCount += 1;
          return `Usage: openclaw ${renderCount}\n`;
        },
        renderSourceBrowserHelpText: countedHelp("browser"),
        renderSourceSecretsHelpText: countedHelp("secrets"),
        renderSourceNodesHelpText: countedHelp("nodes"),
        renderSourceSubcommandHelpTextRecord: renderSubcommandHelp,
      });

    for (const [index, [version, commit, banner]] of (
      [
        ["2026.7.2", "a", "OpenClaw 2026.7.2 (aaaaaaa)"],
        ["2026.7.2", "b", "OpenClaw 2026.7.2 (bbbbbbb)"],
        ["2026.7.3", "b", "OpenClaw 2026.7.3 (bbbbbbb)"],
      ] as const
    ).entries()) {
      writeFixtureFile(
        distDir,
        "build-info.json",
        JSON.stringify({ version, commit: commit.repeat(40) }),
      );
      await writeMetadata();
      if (index === 0) {
        await writeMetadata();
      }
      expect({ renderCount, commandRenderCount }).toEqual({
        renderCount: index + 1,
        commandRenderCount: (index + 1) * 4,
      });
      expect(readFileSync(outputPath, "utf8")).toContain(banner);
    }
    expect(readMetadata(outputPath).subcommandHelpText.models).toContain(
      "OpenClaw 2026.7.3 (bbbbbbb)",
    );
  });
});
