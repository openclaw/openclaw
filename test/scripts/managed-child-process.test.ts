import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";
import {
  createManagedCommandSpawnSpec,
  type ManagedCommandTimeoutObservation,
  inspectManagedProcessGroup,
  runManagedCommand,
  signalExitCode,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../../scripts/lib/managed-child-process.mts";
import {
  createVitestResourceOwner,
  findVitestResourceOwner,
} from "../../scripts/lib/vitest-resource-ownership.mts";
import {
  runNodeStep,
  runNodeStepsInParallel,
} from "../../scripts/prepare-extension-package-boundary-artifacts.mts";
import { isPidAlive } from "../../src/shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../helpers/fixture-receipts.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import {
  assertFixtureProcessGroupStopped,
  exitedDescendantReaper,
} from "./exited-descendant-reaper.test-support.js";
import { captureOutput, psResult } from "./managed-child-process.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const testNodeExecPath = resolveTestNodeExecPath();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const { createTempDir } = createScriptTestHarness();
const posixIt = process.platform === "win32" ? it.skip : it;
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});
const joinedTestBodies = new WeakMap<TestContext, Promise<unknown>>();
function runJoinedManagedTest(context: TestContext, body: () => Promise<void>) {
  const run = Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return body();
  });
  joinedTestBodies.set(context, run);
  context.onTestFinished(() => run);
  return run;
}
function joinedTest(body: (context: TestContext) => Promise<void>) {
  return (context: TestContext) => runJoinedManagedTest(context, () => body(context));
}
function joinedCase<T>(body: (value: T, context: TestContext) => Promise<void>) {
  return (value: T, context: TestContext) =>
    runJoinedManagedTest(context, () => body(value, context));
}
const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");

function runNodeCommand(
  options: Omit<Parameters<typeof runManagedCommand>[0], "bin"> & { bin?: string },
) {
  return runManagedCommand({ bin: process.execPath, shell: false, stdio: "ignore", ...options });
}

function writeFixture(dir: string, name: string, source: string) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, source, "utf8");
  return file;
}

const moduleUrl = (file: string) => pathToFileURL(path.resolve(file)).href;
const managedModuleUrl = moduleUrl("scripts/lib/managed-child-process.mts");
const fixtureEnv = (dir: string) => ({ ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir });

function runController(dir: string, source: string, bin = testNodeExecPath, forceKill = true) {
  const script = path.join(dir, "controller.mjs");
  fs.writeFileSync(script, source);
  const result = spawnSync(bin, [script], {
    encoding: "utf8",
    env: fixtureEnv(dir),
    timeout: 10_000,
    ...(forceKill ? { killSignal: "SIGKILL" as const } : {}),
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function withDefaultWindowsSystemRoot(run: () => void): void {
  const originalSystemRoot = process.env.SystemRoot;
  const originalWindir = process.env.WINDIR;
  try {
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    run();
  } finally {
    restoreEnvValue("SystemRoot", originalSystemRoot);
    restoreEnvValue("WINDIR", originalWindir);
  }
}

function expectProcessPid(pid: number | undefined): number {
  if (pid == null) {
    throw new Error("Expected spawned process to expose a pid");
  }
  return pid;
}

async function killFixturePid(
  pid: number,
  signal: AbortSignal,
  processGroup = false,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error("Invalid owned fixture PID");
  }
  await runQaGatewayFixture(
    async () => {
      try {
        process.kill(processGroup ? -pid : pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    },
    () => waitForFixtureDead(pid, signal),
  );
}

// Call after installing handlers and keepalive: existence must mean a complete, ready PID.
function publishReadyPidScript(argIndex: number): string {
  return `
const pidPath = process.argv[${argIndex}];
fs.writeFileSync(pidPath + ".tmp", String(process.pid));
fs.renameSync(pidPath + ".tmp", pidPath);
`;
}

// PID records are committed before receipts. A completed operation can beat the side channel.
async function fixturePidBeforeSettlement(file: string, operation: PromiseLike<unknown>) {
  await Promise.race([
    receipts.waitFor(file, "ready"),
    Promise.resolve(operation).then(
      () => {
        if (!fs.existsSync(file)) {
          throw new Error(`timeout waiting for pid in ${file}`);
        }
      },
      (error: unknown) => {
        if (!fs.existsSync(file)) {
          throw error;
        }
      },
    ),
  ]);
  const pid = Number(fs.readFileSync(file, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`timeout waiting for pid in ${file}`);
  }
  return pid;
}

const readyPid = (file: string, operation: PromiseLike<unknown>, signal: AbortSignal) =>
  withinTest(fixturePidBeforeSettlement(file, operation), signal);
const joinGate = <T>(gate: PromiseLike<T>, operation: PromiseLike<unknown>, signal: AbortSignal) =>
  withinTest(awaitGateBeforeSettlement(gate, operation, "timed out waiting for condition"), signal);

describe("managed-child-process", () => {
  afterEach(async (context) => {
    // Inner hooks run before the harness removes PID evidence. onTestFinished retains errors.
    await joinedTestBodies.get(context)?.catch(() => {});
  });
  it("registers with the containing owner when the command creates its own TMP leaf", async () => {
    const root = createTempDir("managed-command-owner-");
    const owner = createVitestResourceOwner(root);
    const tmp = path.join(root, "child-tmp");
    const code = await runNodeCommand({
      args: ["-e", "require('node:fs').mkdirSync(process.env.TMPDIR)"],
      env: fixtureEnv(tmp),
      onReady() {
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      },
    });
    expect(code).toBe(0);
    expect(fs.existsSync(tmp)).toBe(true);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  it.runIf(process.platform === "linux")(
    "accepts exited descendants still awaiting reaping",
    async () => {
      const dir = createTempDir("openclaw-managed-zombie-");
      const childPath = writeFixture(
        dir,
        "child.py",
        `import os
pid = os.fork()
if pid == 0:
    os._exit(0)
exited = os.waitid(os.P_PID, pid, os.WEXITED | os.WNOWAIT)
assert exited.si_code == os.CLD_EXITED and exited.si_status == 0
print("retained-descendant", pid, flush=True)
os._exit(0)
`,
      );
      const runnerPath = writeFixture(
        dir,
        "runner.mjs",
        `
import assert from "node:assert/strict";
import { runManagedCommand } from ${JSON.stringify(managedModuleUrl)};
import { assertFixtureProcessGroupStopped } from ${JSON.stringify(pathToFileURL(path.resolve("test/scripts/exited-descendant-reaper.test-support.ts")).href)};
let pgid;
process.exitCode = await runManagedCommand({
  bin: "python3",
  args: [${JSON.stringify(childPath)}],
  requireProcessTreeExit: true,
  onReady(child) { pgid = child.pid; },
});
assert.equal(process.exitCode, 0);
assert.doesNotThrow(() => process.kill(-pgid, 0));
assertFixtureProcessGroupStopped(pgid);
`,
      );
      // Keep a witnessed exited descendant, independent of the runtime's loaders.
      // The subreaper adopts it until the real supervisor has settled.
      let output = "";
      const code = await runManagedCommand({
        bin: "python3",
        args: ["-c", exitedDescendantReaper, process.execPath, runnerPath],
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 10_000,
        onReady(child) {
          for (const pipe of [child.stdout, child.stderr]) {
            pipe?.on("data", (chunk) => (output += String(chunk)));
          }
        },
      });
      expect(code, output).toBe(0);
      expect(output).toMatch(/retained-descendant [1-9]\d*/u);
      expect(output).toMatch(/successfully reaped: [1-9]/u);
    },
  );

  it.each([
    { name: "absent group", firstError: "ESRCH", accepted: true },
    { name: "permission denied", firstError: "EPERM", accepted: false },
    { name: "unknown probe failure", firstError: "EIO", accepted: false },
    { name: "all zombie threads", stdout: "12345 Z\n12345 Z\n", accepted: true },
    { name: "live group", stdout: "12345 S\n", accepted: false },
    { name: "live sibling thread", stdout: "12345 Z\n12345 S\n", accepted: false },
    { name: "wrong group", stdout: "54321 Z\n", accepted: false },
    { name: "unknown state", stdout: "12345 ?\n", accepted: false },
    { name: "malformed row", stdout: "12345 Z extra\n", accepted: false },
    { name: "empty snapshot", stdout: "", accepted: false },
    { name: "partial row", stdout: "12345 Z", accepted: false },
    { name: "failed snapshot", stdout: "12345 Z\n", status: 1, accepted: false },
    { name: "truncated snapshot", stdout: "12345 Z\n", error: "ENOBUFS", accepted: false },
    { name: "signaled snapshot", stdout: "12345 Z\n", signal: "SIGKILL" as const, accepted: false },
    { name: "reaped during snapshot", stdout: "", finalError: "ESRCH", accepted: true },
    { name: "unavailable final probe", stdout: "", finalError: "EPERM", accepted: false },
    { name: "non-Linux group", platform: "darwin" as const, accepted: false },
  ])("verifies stopped fixture groups: $name", (scenario) => {
    let probes = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const code = probes++ === 0 ? scenario.firstError : scenario.finalError;
      if (code) {
        throw Object.assign(new Error("process group lookup failed"), { code });
      }
      return true;
    });
    const ps = vi.mocked(spawnSync).mockImplementation((...call) =>
      psResult(
        // Without thread enumeration, a zombie leader can conceal a live thread.
        scenario.name === "live sibling thread" &&
          !(Array.isArray(call[1]) && call[1].includes("-L"))
          ? "12345 Z\n"
          : (scenario.stdout ?? ""),
        {
          status: scenario.status ?? 0,
          signal: scenario.signal ?? null,
          ...(scenario.error ? { error: new Error(scenario.error) } : {}),
        },
      ),
    );
    try {
      const verify = () => assertFixtureProcessGroupStopped(12345, scenario.platform ?? "linux");
      if (scenario.accepted) {
        expect(verify).not.toThrow();
      } else {
        expect(verify).toThrow();
      }
    } finally {
      ps.mockRestore();
      kill.mockRestore();
    }
  });

  async function runNestedCleanupFixture(
    {
      runner,
      resistant,
      abort,
      bin = testNodeExecPath,
    }: {
      runner: "managed" | "managed-inherit" | "preparation";
      resistant: boolean;
      abort: boolean;
      bin?: string;
    },
    signal: AbortSignal,
    ...cleanups: Array<() => unknown>
  ) {
    const dir = fs.realpathSync(createTempDir("openclaw-nested-timeout-"));
    const pidPaths = ["wrapper", "implementation", "leaf"].map((role) =>
      path.join(dir, `${role}.pid`),
    );
    const publish = (index: number) =>
      `fs.writeFileSync(${JSON.stringify(pidPaths[index])} + '.tmp', String(process.pid)); fs.renameSync(${JSON.stringify(pidPaths[index])} + '.tmp', ${JSON.stringify(pidPaths[index])}); sendReceipt(${JSON.stringify(pidPaths[index])}, "ready");`;
    const wrapper = writeFixture(
      dir,
      "wrapper.mjs",
      `
import fs from 'node:fs';
${fixtureReceiptClientSource(receipts.endpoint)}
import { runTsxCliShim } from ${JSON.stringify(moduleUrl("scripts/lib/tsx-cli-shim.mjs"))};
${publish(0)}
await runTsxCliShim(import.meta.url, { implementation: './implementation.mts', detached: true, forceKillDelayMs: 10000 });
`,
    );
    fs.writeFileSync(
      path.join(dir, "implementation.mts"),
      `
import fs from 'node:fs';
${fixtureReceiptClientSource(receipts.endpoint)}
import { runManagedCommand } from ${JSON.stringify(moduleUrl("scripts/lib/managed-child-process.mts"))};
${publish(1)}
process.exitCode = await runManagedCommand({ bin: process.execPath, args: [${JSON.stringify(path.join(dir, "leaf.mjs"))}], shell: false });
`,
    );
    fs.writeFileSync(
      path.join(dir, "leaf.mjs"),
      `
import fs from 'node:fs';
${fixtureReceiptClientSource(receipts.endpoint)}
process.on('SIGTERM', () => { process.stdout.write('shutdown-tail'); ${resistant ? "" : "process.exit(0);"} });
setInterval(() => {}, 1000);
${publish(2)}
`,
    );
    const abortController = new AbortController();
    const stdout = vi.spyOn(process.stdout, "write");
    let output = "";
    let commandOutcome!: Promise<Error | undefined>;
    const releaseAndWait = startProcessWatchdogFixture(() => {
      const command =
        runner === "preparation"
          ? runNodeStep("nested", [wrapper], 100, { abortController, bin })
          : runManagedCommand({
              bin,
              args: [wrapper],
              stdio: runner === "managed-inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
              timeoutMs: 100,
              onReady: (child) =>
                child.stdout?.on("data", (chunk) => {
                  output += String(chunk);
                }),
            });
      commandOutcome = command.then(
        () => undefined,
        (error: unknown) => toErrorObject(error, "Nested fixture command failed"),
      );
      return commandOutcome;
    });
    const pids: number[] = [];
    let commandOutcomeAsserted = false;
    // Finish cleanup before the harness afterEach removes PID evidence, retaining all failures.
    await runQaGatewayFixture(
      async () => {
        for (const pidPath of pidPaths) {
          pids.push(await readyPid(pidPath, commandOutcome, signal));
        }
        expect(pids.every(isProcessAlive)).toBe(true);
        if (abort) {
          abortController.abort();
        }
        expect(await withinTest(releaseAndWait(), signal)).toMatchObject({
          message: expect.stringContaining(
            abort ? "canceled after sibling failure" : "timed out after 100ms",
          ),
        });
        commandOutcomeAsserted = true;
        expect(
          pids.filter(isProcessAlive),
          "timeout must join every nested child before rejection",
        ).toEqual([]);
        if (runner === "preparation") {
          expect(
            stdout.mock.calls.some(([chunk]) => String(chunk) === "[nested] shutdown-tail"),
          ).toBe(true);
        } else if (runner === "managed-inherit") {
          expect(stdout.mock.calls.some(([chunk]) => String(chunk) === "shutdown-tail")).toBe(true);
        } else {
          expect(output).toBe("shutdown-tail");
        }
      },
      async () => {
        const error = await releaseAndWait();
        // Immediate observation prevents unhandled rejection during PID waits;
        // cleanup must surface failures the body never successfully asserted.
        if (!commandOutcomeAsserted && error !== undefined) {
          throw error;
        }
      },
      () => stdout.mockRestore(),
      ...pidPaths.toReversed().map((pidPath) => async () => {
        if (fs.existsSync(pidPath)) {
          await killFixturePid(Number(fs.readFileSync(pidPath, "utf8")), signal);
        }
      }),
      ...cleanups,
    );
  }

  posixIt.for([
    { runner: "managed", resistant: false, abort: false },
    { runner: "managed", resistant: true, abort: false },
    { runner: "managed-inherit", resistant: true, abort: false },
    { runner: "preparation", resistant: false, abort: false },
    { runner: "preparation", resistant: true, abort: false },
    { runner: "preparation", resistant: false, abort: true },
    { runner: "preparation", resistant: true, abort: true },
  ] as const)(
    "joins nested $runner cleanup (resistant=$resistant, abort=$abort)",
    { timeout: 20_000 },
    joinedCase(async (params, { signal }) => runNestedCleanupFixture(params, signal)),
  );

  posixIt.for(["managed", "preparation"] as const)(
    "retains pre-PID $0 launch failure while completing nested cleanup",
    { timeout: 20_000 },
    joinedCase(async (runner, { signal }) => {
      const bin = path.join(createTempDir("openclaw-nested-startup-"), "missing-node");
      const lastCleanup = vi.fn();
      const failure = await runNestedCleanupFixture(
        { runner, resistant: false, abort: false, bin },
        signal,
        lastCleanup,
      ).catch((error: unknown) => error);

      expect(lastCleanup).toHaveBeenCalledOnce();
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({
        errors: [
          { message: expect.stringMatching(/timeout waiting for pid in .*wrapper\.pid$/u) },
          { code: "ENOENT", path: bin, message: expect.stringContaining(bin) },
        ],
      });
    }),
  );

  it("rejects timeout values beyond Node's timer range", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/lib/bounded-command.mjs",
        "2147483648",
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("timeout-ms must be at most 2147483647");
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  });

  posixIt(
    "keeps the bounded launcher alive until nested signal cleanup finishes",
    joinedTest(async ({ signal }) => {
      const dir = createTempDir("openclaw-bounded-launcher-cleanup-");
      const leafPidPath = path.join(dir, "leaf.pid");
      const leafPath = writeFixture(
        dir,
        "leaf.mjs",
        `
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}
process.on("SIGTERM", () => {});
setInterval(() => {}, 1_000);
fs.writeFileSync(process.argv[2], String(process.pid));
sendReceipt(process.argv[2], "ready");
`,
      );
      const launcher = spawn(
        process.execPath,
        ["scripts/lib/bounded-command.mjs", "60000", "--", process.execPath, leafPath, leafPidPath],
        { detached: true, stdio: "ignore" },
      );
      const closed = waitForClose(launcher);
      let leafPid = 0;
      try {
        leafPid = await readyPid(leafPidPath, closed, signal);
        process.kill(-launcher.pid!, "SIGTERM");
        await expect(withinTest(closed, signal)).resolves.toEqual({ code: 143, signal: null });
        // Launcher completion joins the strict implementation and its managed process tree.
        expect(isPidAlive(leafPid)).toBe(false);
      } finally {
        if (launcher.pid && isProcessAlive(launcher.pid)) {
          process.kill(-launcher.pid, "SIGKILL");
        }
        if (leafPid && isProcessAlive(leafPid)) {
          process.kill(leafPid, "SIGKILL");
        }
        await closed;
      }
    }),
    15_000,
  );

  it("maps forwarded signals to shell-compatible exit codes", () => {
    expect(signalExitCode("SIGHUP")).toBe(129);
    expect(signalExitCode("SIGINT")).toBe(130);
    expect(signalExitCode("SIGTERM")).toBe(143);
    expect(signalExitCode("SIGKILL")).toBe(137);
  });

  it("wraps Windows shell argv through cmd.exe without Node shell mode", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["lint:scripts", "--", "scripts"],
        bin: "pnpm.cmd",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
        shell: true,
      }),
    ).toEqual({
      args: ["/d", "/s", "/c", "pnpm.cmd lint:scripts -- scripts"],
      command: "C:\\Windows\\System32\\cmd.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: {},
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    });
  });

  it("uses Windows shell normalization when the platform override is win32", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["-p", "packages/plugin-sdk/tsconfig.json", "--listFilesOnly", "--noEmit"],
        bin: "C:\\repo\\node_modules\\.bin\\tsgo",
        comSpec: "C:\\Windows\\System32\\cmd.exe",
        env: {},
        platform: "win32",
      }),
    ).toEqual({
      args: [
        "/d",
        "/s",
        "/c",
        "C:\\repo\\node_modules\\.bin\\tsgo -p packages/plugin-sdk/tsconfig.json --listFilesOnly --noEmit",
      ],
      command: "C:\\Windows\\System32\\cmd.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: {},
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: true,
      },
    });
  });

  it("preserves explicit non-shell Windows subprocesses", () => {
    expect(
      createManagedCommandSpawnSpec({
        args: ["--version"],
        bin: "node.exe",
        platform: "win32",
        shell: false,
      }),
    ).toEqual({
      args: ["--version"],
      command: "node.exe",
      options: {
        cwd: undefined,
        detached: false,
        env: undefined,
        shell: false,
        stdio: "inherit",
        windowsVerbatimArguments: undefined,
      },
    });
  });

  it("rejects unsafe Windows shell argv instead of passing them to Node shell mode", () => {
    expect(() =>
      createManagedCommandSpawnSpec({
        args: ["build && pnpm test"],
        bin: "pnpm.cmd",
        platform: "win32",
        shell: true,
      }),
    ).toThrow("unsafe Windows cmd.exe argument detected");
  });

  it("signals Windows managed process trees with taskkill", () => {
    withDefaultWindowsSystemRoot(() => {
      const child = {
        kill: vi.fn(),
        pid: 12345,
      };
      const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

      terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/PID", "12345", "/T"], {
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });

      terminateManagedChild(child, "SIGKILL", {
        platform: "win32",
        runTaskkill,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/PID", "12345", "/T", "/F"], {
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10_000,
      });
      expect(child.kill).not.toHaveBeenCalled();
    });
  });

  it.each<{
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    signal: NodeJS.Signals;
  }>([
    { exitCode: 0, signalCode: null, signal: "SIGTERM" },
    { exitCode: null, signalCode: "SIGTERM", signal: "SIGKILL" },
  ])(
    "does not target a known-exited Windows child ($exitCode/$signalCode)",
    ({ exitCode, signalCode, signal }) => {
      const child = { exitCode, signalCode, kill: vi.fn(() => true), pid: 12345 };
      const runTaskkill = vi.fn(() => ({ status: 0 }));

      const result = terminateManagedChild(child, signal, {
        platform: "win32",
        runTaskkill,
      });

      expect(runTaskkill).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
      // Exit retires PID authority, not proof that inherited descendants are gone.
      expect(result).toEqual({ processTreeState: "indeterminate" });
    },
  );

  it.each([false, true])("escalates trusted Windows taskkill (stdio only: %s)", (stdioOnly) => {
    withDefaultWindowsSystemRoot(() => {
      const child = { kill: vi.fn(() => (stdioOnly ? true : undefined)), pid: process.pid };
      const runTaskkill = vi
        .fn()
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce({ status: stdioOnly ? 1 : 0 });
      const result = terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
        ...(stdioOnly ? { taskkillTimeoutMs: null } : {}),
      });
      const options = {
        stdio: ["ignore", "pipe", "pipe"],
        ...(stdioOnly ? {} : { killSignal: "SIGKILL", timeout: 10_000 }),
      };
      expect(runTaskkill.mock.calls).toEqual([
        [taskkillPath, ["/PID", String(child.pid), "/T"], options],
        [taskkillPath, ["/PID", String(child.pid), "/T", "/F"], options],
      ]);
      if (stdioOnly) {
        expect(result).toEqual({ processTreeState: "indeterminate", error: expect.any(Error) });
        expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      } else {
        expect(child.kill).not.toHaveBeenCalled();
      }
    });
  });

  it("preserves direct Windows signaling when a caller does not own taskkill", () => {
    const child = { kill: vi.fn(() => true), pid: 12345 };
    const runTaskkill = vi.fn();

    expect(
      terminateManagedChild(child, "SIGTERM", {
        platform: "win32",
        runTaskkill,
        useWindowsTaskkill: false,
      }),
    ).toEqual({ processTreeState: "signaled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("signals POSIX process groups without signaling their leaders twice", () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const child = { kill: vi.fn(), pid: 12345 };

    try {
      expect(terminateManagedChild(child, "SIGTERM", { platform: "linux" })).toEqual({
        processTreeState: "signaled",
      });
      expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it.each([
    { code: "ESRCH", processGroupFallback: "nonmissing" as const },
    { code: "EPERM", processGroupFallback: "never" as const },
  ])("preserves caller-owned direct fallback for $code", ({ code, processGroupFallback }) => {
    const error = Object.assign(new Error("process group unavailable"), { code });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw error;
    });
    const child = { kill: vi.fn(), pid: 12345 };

    try {
      terminateManagedChild(child, "SIGTERM", { platform: "linux", processGroupFallback });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it("preserves indeterminate group state after the leader exits", () => {
    const permissionError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const child = { exitCode: null, pid: 12345, signalCode: null };
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === -12345) {
        throw permissionError;
      }
      return true;
    });

    try {
      expect(
        inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm", platform: "linux" }),
      ).toBe("live");
      expect(
        inspectManagedProcessGroup(child, { errorPolicy: "indeterminate", platform: "linux" }),
      ).toBe("indeterminate");
      expect(
        inspectManagedProcessGroup(
          { ...child, exitCode: 0 },
          { errorPolicy: "indeterminate", platform: "linux" },
        ),
      ).toBe("indeterminate");
      expect(kill).not.toHaveBeenCalledWith(12345, 0);
    } finally {
      kill.mockRestore();
    }
  });

  it("inspects direct child liveness only when nongroup cleanup explicitly requires it", () => {
    const child = { exitCode: null, pid: 12345, signalCode: null };

    expect(
      inspectManagedProcessGroup(child, { errorPolicy: "alive-on-eperm", platform: "win32" }),
    ).toBe("indeterminate");
    expect(
      inspectManagedProcessGroup(child, {
        errorPolicy: "alive-on-eperm",
        inspectLeaderWhenNoGroup: true,
        platform: "win32",
      }),
    ).toBe("live");
    expect(
      inspectManagedProcessGroup(
        { ...child, exitCode: 0 },
        { errorPolicy: "alive-on-eperm", inspectLeaderWhenNoGroup: true, platform: "win32" },
      ),
    ).toBe("dead");
  });

  type SnapshotCase = {
    snapshot: "empty" | "live" | "failed" | "zombie" | "zombie-leader";
    afterSnapshot: string | null;
    expected: ReturnType<typeof inspectManagedProcessGroup>;
    policy?: Parameters<typeof inspectManagedProcessGroup>[1]["errorPolicy"];
    platform?: NodeJS.Platform;
    running?: boolean;
    remainingMs?: number;
    snapshotTimeoutMs?: number;
  };
  const groupCase = (
    snapshot: SnapshotCase["snapshot"],
    afterSnapshot: string | null,
    expected: SnapshotCase["expected"],
    options: Partial<SnapshotCase> = {},
  ): SnapshotCase => ({ snapshot, afterSnapshot, expected, ...options });

  it.each([
    groupCase("live", "ESRCH", "dead"),
    groupCase("empty", null, "live"),
    groupCase("live", null, "live"),
    groupCase("failed", null, "live"),
    groupCase("zombie", null, "dead"),
    groupCase("zombie-leader", null, "live"),
    groupCase("empty", "EPERM", "live"),
    groupCase("empty", "EPERM", "indeterminate", { policy: "indeterminate" }),
    groupCase("empty", "EIO", "indeterminate", { policy: "indeterminate" }),
    groupCase("empty", "EIO", "indeterminate"),
    groupCase("zombie", null, "live", { platform: "darwin" }),
    groupCase("zombie", null, "live", { running: true }),
    groupCase("zombie", null, "dead", { remainingMs: 20, snapshotTimeoutMs: 20 }),
    groupCase("zombie", null, "dead", { remainingMs: 10_000, snapshotTimeoutMs: 5_000 }),
    groupCase("zombie-leader", null, "live", { remainingMs: 20, snapshotTimeoutMs: 20 }),
    groupCase("failed", "ESRCH", "dead", { remainingMs: 20, snapshotTimeoutMs: 20 }),
    groupCase("zombie", null, "live", { remainingMs: 0 }),
    groupCase("zombie", null, "live", { remainingMs: -1 }),
    groupCase("zombie", "ESRCH", "dead", { remainingMs: 0 }),
    groupCase("zombie", "EPERM", "indeterminate", { remainingMs: 0, policy: "indeterminate" }),
  ])(
    "checks current group state after $snapshot snapshot ($afterSnapshot, $policy, $platform, $running, budget $remainingMs)",
    ({
      snapshot,
      afterSnapshot,
      expected,
      policy = "alive-on-eperm",
      platform = "linux",
      running,
      remainingMs,
      snapshotTimeoutMs = 5_000,
    }) => {
      let inspected = false;
      let probes = 0;
      const clock =
        remainingMs === undefined ? undefined : vi.spyOn(Date, "now").mockReturnValue(1_000);
      const kill = vi.spyOn(process, "kill").mockImplementation(() => {
        probes += 1;
        if (
          (inspected || (remainingMs !== undefined && remainingMs <= 0 && probes > 1)) &&
          afterSnapshot
        ) {
          throw Object.assign(new Error("group lookup failed"), { code: afterSnapshot });
        }
        return true;
      });
      const ps = vi
        .mocked(spawnSync)
        .mockClear()
        .mockImplementation((...call) => {
          inspected = true;
          // Mirror /proc reporting: without -L, ps collapses a pthread_exit leader
          // with a live sibling thread into one Z process row; -L exposes the thread.
          const threadRows = Array.isArray(call[1]) && call[1].includes("-L");
          const stdout =
            snapshot === "zombie-leader"
              ? threadRows
                ? "12345 Z\n12345 S\n"
                : "12345 Z\n"
              : snapshot === "zombie"
                ? "12345 Z\n"
                : snapshot === "live"
                  ? "12345 S\n"
                  : "";
          return psResult(stdout, {
            status: snapshot === "empty" ? 1 : 0,
            ...(snapshot === "failed" ? { error: new Error("ps unavailable") } : {}),
          });
        });
      try {
        const options = {
          errorPolicy: policy,
          platform,
          ...(remainingMs === undefined ? {} : { deadlineAt: Date.now() + remainingMs }),
        };
        expect(
          inspectManagedProcessGroup(
            { pid: 12345, exitCode: running ? null : 0, signalCode: null },
            options,
          ),
        ).toBe(expected);
        const snapshotExpected =
          platform === "linux" && !running && (remainingMs === undefined || remainingMs > 0);
        expect(ps).toHaveBeenCalledTimes(snapshotExpected ? 1 : 0);
        if (snapshotExpected) {
          expect(ps).toHaveBeenCalledWith(
            "ps",
            ["-s", "12345", "-L", "-o", "pgid=,state="],
            expect.objectContaining({ timeout: snapshotTimeoutMs, killSignal: "SIGKILL" }),
          );
        }
      } finally {
        ps.mockRestore();
        kill.mockRestore();
        clock?.mockRestore();
      }
    },
  );

  it("bounds process-group waiting when the group remains live", async () => {
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      await expect(
        waitForManagedProcessGroupExit({ pid: 12345 }, 5, {
          errorPolicy: "alive-on-eperm",
          platform: "linux",
          pollIntervalMs: 1,
        }),
      ).resolves.toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it.each([
    { mode: "waiter", cleanupDrainTimeoutMs: undefined },
    { mode: "normal exit", cleanupDrainTimeoutMs: undefined },
    { mode: "normal exit", cleanupDrainTimeoutMs: 37 },
    { mode: "zombie normal exit", cleanupDrainTimeoutMs: undefined },
    { mode: "graceful abort", cleanupDrainTimeoutMs: undefined },
    { mode: "force on leader exit", cleanupDrainTimeoutMs: undefined },
  ] as const)(
    "includes Linux snapshot work in the $mode deadline (drain: $cleanupDrainTimeoutMs)",
    ({ mode, cleanupDrainTimeoutMs }) => {
      const dir = createTempDir("openclaw-managed-probe-deadline-");
      // Deliberately failed mock cleanup owns its claim separately from real fixture jobs.
      createVitestResourceOwner(dir);
      runController(
        dir,
        `
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const mode = ${JSON.stringify(mode)};
const cleanupDrainTimeoutMs = ${JSON.stringify(cleanupDrainTimeoutMs)};
let now = 1_000, live = true;
const probes = [], signals = [];
const child = Object.assign(new EventEmitter(), {
  pid: 12345, exitCode: 0, signalCode: null,
  stdin: null, stdout: null, stderr: null,
  kill() { throw new Error("must signal the owned group"); },
});
Object.defineProperty(child, "stdio", {
  get: () => [child.stdin, child.stdout, child.stderr, null],
});
Date.now = () => now;
process.kill = (pid, signal) => {
  assert.equal(pid, -child.pid);
  if (!live) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
  if (signal !== 0) {
    signals.push({ signal, at: now });
    if (signal === "SIGKILL" && mode !== "normal exit") {
      live = false;
      child.exitCode = null;
      child.signalCode = "SIGKILL";
      child.emit("exit", null, "SIGKILL");
      child.emit("close", null, "SIGKILL");
    }
  }
  return true;
};
cp.spawn = () => child;
cp.spawnSync = (bin, args, options) => {
  assert.equal(bin, "ps");
  assert.ok(args.includes("-L"));
  assert.ok(Number.isInteger(options.timeout) && options.timeout > 0);
  probes.push({ at: now, timeout: options.timeout });
  if (mode === "zombie normal exit") {
    now += 1;
    return { pid: 12346, output: [], status: 0, signal: null, stdout: "12345 Z\\n", stderr: "" };
  }
  now += options.timeout;
  return { pid: 12346, output: [], status: null, signal: "SIGKILL",
    stdout: "", stderr: "", error: Object.assign(new Error("snapshot timed out"), { code: "ETIMEDOUT" }) };
};
syncBuiltinESMExports();
const { runManagedCommand, waitForManagedProcessGroupExit } =
  await import(${JSON.stringify(managedModuleUrl)});
const started = now;
let outcome;
if (mode === "waiter") {
  outcome = await waitForManagedProcessGroupExit(child, 20, {
    errorPolicy: "indeterminate", platform: "linux", clampPollToDeadline: true, pollIntervalMs: 1,
  });
} else {
  const abort = new AbortController();
  outcome = await runManagedCommand({
    bin: "mocked-owned-child", platform: "linux", shell: false, stdio: "ignore",
    requireProcessTreeExit: true, signal: abort.signal, abortKillGraceMs: 100,
    cleanupDrainTimeoutMs,
    ...(mode === "force on leader exit" ? {
      timeoutMs: 0, timeoutKillGraceMs: 100, timeoutForceKillOnLeaderExit: true,
    } : {}),
    onReady() {
      if (mode === "normal exit" || mode === "zombie normal exit") {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      } else if (mode === "graceful abort") abort.abort();
    },
  }).catch(error => error.code);
}
console.log(JSON.stringify({ mode, elapsed: now - started, outcome, probes, signals }));
if (mode === "waiter") {
  assert.equal(outcome, false, "budget exhaustion must not establish death");
  assert.ok(now - started <= 20, "terminal probe must not refresh the waiter's allowance");
  assert.equal(probes.length, 1);
} else if (mode === "normal exit") {
  assert.equal(outcome, "EPROCESSGROUP_CLEANUP_FAILED");
  assert.ok(now - started <= (cleanupDrainTimeoutMs ?? 5_000), "preliminary snapshot must be charged to finalization");
  assert.ok(signals.some(entry => entry.signal === "SIGKILL"));
} else if (mode === "zombie normal exit") {
  assert.equal(outcome, 0, "completed zombie-only group remains a successful normal exit");
  assert.deepEqual(signals, []);
  assert.ok(probes.length > 0);
} else {
  const forceBudget = mode === "graceful abort" ? 100 : 0;
  assert.equal(outcome, mode === "graceful abort" ? "ABORT_ERR" : "ETIMEDOUT");
  const forced = signals.find(entry => entry.signal === "SIGKILL");
  assert.ok(forced && forced.at - started <= forceBudget, "snapshot must not delay escalation");
  assert.equal(live, false);
}
`,
      );
    },
  );

  it("signals the direct child when process-group ownership is disabled", () => {
    const child = { kill: vi.fn(() => true), pid: 12345 };

    expect(
      terminateManagedChild(child, "SIGTERM", {
        platform: "linux",
        useProcessGroup: false,
      }),
    ).toEqual({ processTreeState: "signaled" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("reports process-group signal errors before falling back to the direct child", () => {
    const originalKill = process.kill.bind(process);
    const groupError = Object.assign(new Error("group signal denied"), { code: "EPERM" });
    const child = { kill: vi.fn(() => true), pid: 12345 };
    const onProcessGroupSignalError = vi.fn();
    process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -12345 && signal === "SIGTERM") {
        throw groupError;
      }
      return originalKill(pid, signal);
    }) as typeof process.kill;

    try {
      expect(
        terminateManagedChild(child, "SIGTERM", {
          onProcessGroupSignalError,
          platform: "linux",
        }),
      ).toEqual({ processTreeState: "signaled" });
    } finally {
      process.kill = originalKill;
    }

    expect(onProcessGroupSignalError).toHaveBeenCalledWith(groupError);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it.for(["ignore", "inherit"] as const)(
    "shares listeners across parallel %s commands even when another spawn throws",
    joinedCase(async (stdio, { signal }) => {
      const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
      const baseline = new Map(
        signals.map((forwarded) => [forwarded, process.listenerCount(forwarded)]),
      );
      const warnings: string[] = [];
      const onWarning = (warning: Error) => {
        if (warning.name === "MaxListenersExceededWarning") {
          warnings.push(warning.message);
        }
      };
      process.on("warning", onWarning);
      const stdout = vi.spyOn(process.stdout, "write");
      const stderr = vi.spyOn(process.stderr, "write");
      const children: Array<Parameters<typeof terminateManagedChild>[0]> = [];
      const ready = createDeferred();
      const outputReady = createDeferred();
      const outputLines = (output: typeof stdout, kind: string) =>
        output.mock.calls
          .map(([chunk]) => String(chunk))
          .join("")
          .split("\n")
          .filter((line) => line.startsWith(`managed-parallel-${kind}-`))
          .toSorted();
      const observeOutput = () => {
        if (outputLines(stdout, "out").length === 12 && outputLines(stderr, "err").length === 12) {
          outputReady.resolve();
        }
      };
      const commands = Array.from({ length: 12 }, (_, index) =>
        runNodeCommand({
          args: [
            "-e",
            `process.stdout.write('managed-parallel-out-${index}-π\\n'); process.stderr.write('managed-parallel-err-${index}-π\\n'); setTimeout(() => {}, 10_000);`,
          ],
          stdio,
          onReady: (child) => {
            children.push(child);
            child.stdout?.on("data", observeOutput);
            child.stderr?.on("data", observeOutput);
            if (children.length === 12) {
              ready.resolve();
            }
          },
        }),
      );

      try {
        await joinGate(ready.promise, Promise.race(commands), signal);
        await expect(runManagedCommand({ bin: "invalid\0command" })).rejects.toMatchObject({
          code: "ERR_INVALID_ARG_VALUE",
        });
        for (const forwarded of signals) {
          expect(process.listenerCount(forwarded)).toBe((baseline.get(forwarded) ?? 0) + 1);
        }
        if (stdio === "inherit" && process.platform !== "win32") {
          await joinGate(outputReady.promise, Promise.race(commands), signal);
          for (const [output, kind] of [
            [stdout, "out"],
            [stderr, "err"],
          ] as const) {
            expect(outputLines(output, kind)).toEqual(
              Array.from(
                { length: 12 },
                (_, index) => `managed-parallel-${kind}-${index}-π`,
              ).toSorted(),
            );
          }
        }
      } finally {
        for (const child of children) {
          terminateManagedChild(child, "SIGTERM");
        }
        await Promise.all(commands);
        process.off("warning", onWarning);
        stdout.mockRestore();
        stderr.mockRestore();
      }

      expect(warnings).toEqual([]);
      expect(children.every((child) => !child.pid || !isProcessAlive(child.pid))).toBe(true);
      for (const forwarded of signals) {
        expect(process.listenerCount(forwarded)).toBe(baseline.get(forwarded) ?? 0);
      }
    }),
  );

  it.each([
    { bin: "invalid\0command", code: "ERR_INVALID_ARG_VALUE" },
    { bin: "/missing/openclaw-test-command", code: "ENOENT" },
  ])("restores signal listeners after a $code spawn failure", async ({ bin, code }) => {
    const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
    const baseline = signals.map((signal) => process.listenerCount(signal));
    await expect(runManagedCommand({ bin, shell: false })).rejects.toMatchObject({ code });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(baseline);
  });

  it(
    "times out and kills managed command descendants",
    joinedTest(async ({ signal }) => {
      const dir = createTempDir("openclaw-managed-timeout-");
      const childPidPath = path.join(dir, "child.pid");
      const descendantPidPath = path.join(dir, "descendant.pid");
      const signalPath = path.join(dir, "signal.txt");
      const childPath = writeFixture(
        dir,
        "child.mjs",
        `
import { spawn } from "node:child_process";
import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}

process.on("SIGTERM", () => fs.writeFileSync(process.argv[4], "SIGTERM\\n"));
setInterval(() => {}, 1_000);
const descendant = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${publishReadyPidScript(1)}
process.send("ready");
`)},
  process.argv[3],
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
descendant.once("message", () => sendReceipt(process.argv[3], "ready"));
${publishReadyPidScript(2)}
sendReceipt(process.argv[2], "ready");
`,
      );

      let childClosed: Promise<unknown> | undefined;
      let outcome!: Promise<unknown>;
      const releaseAndWait = startProcessWatchdogFixture(
        () =>
          (outcome = expect(
            runNodeCommand({
              args: [childPath, childPidPath, descendantPidPath, signalPath],
              timeoutKillGraceMs: 100,
              timeoutMs: 500,
              onReady: (child) => {
                childClosed = waitForClose(child);
              },
            }),
          ).rejects.toMatchObject({ code: "ETIMEDOUT" })),
      );
      const killSpy = vi.spyOn(process, "kill");
      let childPid = 0;
      let descendantPid = 0;
      try {
        childPid = await readyPid(childPidPath, outcome, signal);
        descendantPid = await readyPid(descendantPidPath, outcome, signal);
        expect(isProcessAlive(childPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);
        await withinTest(releaseAndWait(), signal);
        if (process.platform !== "win32") {
          expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
          expect(killSpy).toHaveBeenCalledWith(-childPid, "SIGKILL");
        }
        expect(isProcessAlive(childPid)).toBe(false);
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        try {
          await releaseAndWait();
        } finally {
          killSpy.mockRestore();
          if (!childPid && fs.existsSync(childPidPath)) {
            childPid = Number(fs.readFileSync(childPidPath, "utf8"));
          }
          if (!descendantPid && fs.existsSync(descendantPidPath)) {
            descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
          }
          try {
            if (childPid && isProcessAlive(childPid)) {
              process.kill(childPid, "SIGKILL");
              await childClosed;
            }
          } finally {
            if (descendantPid && isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
              await waitForFixtureDead(descendantPid, signal);
            }
          }
        }
      }
    }),
  );

  posixIt("lets a timed-out command handle SIGTERM before forced cleanup", async () => {
    const dir = createTempDir("openclaw-managed-timeout-grace-");
    const signalPath = path.join(dir, "signal.txt");
    const childPath = writeFixture(
      dir,
      "child.mjs",
      `
import fs from "node:fs";
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[2], "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
    );

    await expect(
      runNodeCommand({
        args: [childPath, signalPath],
        timeoutKillGraceMs: 10_000,
        timeoutMs: 500,
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
  });

  posixIt("force-kills descendants after the timed-out leader exits during grace", async () => {
    const dir = createTempDir("openclaw-managed-timeout-leader-exit-");
    const descendantPidPath = path.join(dir, "descendant.pid");
    const signalPath = path.join(dir, "signal.txt");
    const childPath = writeFixture(
      dir,
      "child.mjs",
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(descendant.pid));
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[3], "SIGTERM\\n");
  process.exit(0);
});
setInterval(() => {}, 1_000);
`,
    );

    let descendantPid = 0;
    try {
      const startedAt = Date.now();
      await expect(
        runNodeCommand({
          args: [childPath, descendantPidPath, signalPath],
          timeoutForceKillOnLeaderExit: true,
          timeoutKillGraceMs: 10_000,
          timeoutMs: 500,
        }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });

      descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
      expect(fs.readFileSync(signalPath, "utf8")).toBe("SIGTERM\n");
      expect(isProcessAlive(descendantPid)).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  });

  it("uses a wall timeout even while the child emits progress", async () => {
    const startedAt = Date.now();
    let observation: ManagedCommandTimeoutObservation | undefined;
    await expect(
      runNodeCommand({
        args: ["-e", "setInterval(() => process.stderr.write('retrying\\n'), 20)"],
        timeoutMs: 200,
        stdio: ["ignore", "pipe", "pipe"],
        onTimeout(snapshot) {
          observation = snapshot;
        },
      }),
    ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    expect(observation).toMatchObject({
      exit: null,
      stdout: { bytes: 0, lastDataElapsedMs: null, closed: false },
      stderr: { closed: false },
    });
    expect(observation?.stderr?.bytes).toBeGreaterThan(0);
    expect(observation?.stderr?.lastDataElapsedMs).toBeLessThanOrEqual(observation!.elapsedMs);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("refuses strict Windows commands before spawning an unverifiable tree", async () => {
    const onReady = vi.fn();
    const runTaskkill = vi.fn();
    await expect(
      runNodeCommand({
        args: ["-e", "process.exit(0)"],
        onReady,
        platform: "win32",
        requireProcessTreeExit: true,
        runTaskkill,
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({
      code: "EPROCESS_TREE_VERIFICATION_UNSUPPORTED",
    });
    expect(onReady).not.toHaveBeenCalled();
    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it(
    "fails closed when Windows taskkill cannot verify timeout cleanup",
    joinedTest(async ({ signal }) => {
      const root = createTempDir("managed-command-owner-");
      const owner = createVitestResourceOwner(root);
      const originalSystemRoot = process.env.SystemRoot;
      const originalWindir = process.env.WINDIR;
      let childPid = 0;
      let childClosed: Promise<unknown> | undefined;
      const runTaskkill = vi.fn(() => ({
        error: Object.assign(new Error("taskkill timed out"), { code: "ETIMEDOUT" }),
        status: null,
      }));
      try {
        process.env.SystemRoot = "C:\\Windows";
        delete process.env.WINDIR;
        await expect(
          runNodeCommand({
            args: ["-e", "setInterval(() => {}, 1_000)"],
            onReady: (child) => {
              childPid = expectProcessPid(child.pid);
              childClosed = waitForClose(child);
            },
            platform: "win32",
            runTaskkill,
            env: fixtureEnv(root),
            timeoutMs: 200,
          }),
        ).rejects.toMatchObject({
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          manualRecoveryRequired: true,
          processTreeState: "indeterminate",
        });

        expect(runTaskkill).toHaveBeenCalledWith(
          taskkillPath,
          ["/PID", String(childPid), "/T", "/F"],
          {
            killSignal: "SIGKILL",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 10_000,
          },
        );
        if (!childClosed) {
          throw new Error("Expected managed child close observer");
        }
        await withinTest(childClosed, signal);
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      } finally {
        restoreEnvValue("SystemRoot", originalSystemRoot);
        restoreEnvValue("WINDIR", originalWindir);
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        await childClosed;
      }
    }),
  );

  it.each(["normal exit", "early close", "abort", "setup failure", "missing close"] as const)(
    "joins actual output close events after %s",
    (mode) => {
      const dir = createTempDir("openclaw-managed-output-close-");
      // A failed mock join retains its own claim, separate from real test children.
      createVitestResourceOwner(dir);
      runController(
        dir,
        `
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
const mode = ${JSON.stringify(mode)};
// Node's Socket.closed becomes true before its native handle emits close.
const outputs = [0, 1].map(() => Object.assign(new EventEmitter(), {
  closed: true, destroy() { this.destroyed = true; },
}));
let child, closedOutputs = 0;
const maybeCloseChild = () => {
  if (closedOutputs === outputs.length &&
      (child.exitCode !== null || child.signalCode !== null)) {
    child.emit("close", child.exitCode, child.signalCode);
  }
};
const externalClose = () => { closedOutputs++; maybeCloseChild(); };
for (const output of outputs) output.on("close", externalClose);
child = Object.assign(new EventEmitter(), {
  pid: 12345, exitCode: null, signalCode: null,
  stdin: null, stdout: outputs[0], stderr: outputs[1],
  kill() { throw new Error("must signal the owned group"); },
});
Object.defineProperty(child, "stdio", {
  get: () => [child.stdin, child.stdout, child.stderr, null],
});
cp.spawn = () => child;
process.kill = (pid, signal) => {
  assert.equal(pid, -child.pid);
  if (child.exitCode !== null || child.signalCode !== null) {
    throw Object.assign(new Error("group gone"), { code: "ESRCH" });
  }
  if (signal !== 0) {
    child.signalCode = signal;
    child.emit("exit", null, signal);
    maybeCloseChild();
  }
  return true;
};
syncBuiltinESMExports();
const { runManagedCommand } =
  await import(${JSON.stringify(managedModuleUrl)});
const { findVitestResourceOwner } =
  await import(${JSON.stringify(pathToFileURL(path.resolve("scripts/lib/vitest-resource-ownership.mts")).href)});
const owner = findVitestResourceOwner();
assert.ok(owner);
const abort = new AbortController();
const setupError = new Error("setup failed");
let settled = false;
mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
try {
  const command = runManagedCommand({
    bin: "mocked-owned-child", platform: "linux", shell: false,
    stdio: ["ignore", "pipe", "pipe"], requireProcessTreeExit: true,
    signal: abort.signal,
    onReady() {
      if (mode === "early close") {
        for (const output of outputs) output.emit("close");
      }
      if (mode === "abort") abort.abort();
      else if (mode === "setup failure") throw setupError;
      else {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        maybeCloseChild();
      }
    },
  }).then(value => ({ value }), error => ({ error })).finally(() => { settled = true; });
  // Yield only to flush promise/event callbacks; the drainage clock is controlled.
  await new Promise(setImmediate);
  if (mode !== "early close") {
    assert.equal(settled, false, "closed flags must not release output ownership");
    assert.throws(() => owner.assertReleased(), /Unreleased Vitest resource claim/);
    outputs[0].emit("close");
    mock.timers.tick(25);
    await new Promise(setImmediate);
    assert.equal(settled, false, "both output close events are required");
    assert.throws(() => owner.assertReleased(), /Unreleased Vitest resource claim/);
    if (mode === "missing close") mock.timers.tick(10_000);
    else {
      outputs[1].emit("close");
      mock.timers.tick(25);
    }
  }
  const result = await command;
  if (mode === "missing close") {
    assert.equal(result.error?.code, "EPROCESSGROUP_CLEANUP_FAILED");
    assert.equal(result.error.processTreeState, "indeterminate");
    assert.throws(() => owner.assertReleased(), /Unreleased Vitest resource claim/);
  } else {
    if (mode === "abort") assert.equal(result.error?.code, "ABORT_ERR");
    else if (mode === "setup failure") assert.equal(result.error, setupError);
    else assert.equal(result.value, 0);
    owner.assertReleased();
  }
  for (const output of outputs) {
    assert.deepEqual(output.listeners("close"), [externalClose], "detach only owned listeners");
  }
} finally {
  mock.timers.reset();
}
`,
      );
    },
  );

  posixIt("joins real captured output before releasing strict command ownership", async () => {
    const dir = createTempDir("openclaw-managed-real-output-close-");
    const owner = createVitestResourceOwner(dir);
    const closed = [false, false];
    const output = ["", ""];
    const code = await runManagedCommand({
      bin: testNodeExecPath,
      args: ["-e", "process.stdout.write('out'); process.stderr.write('err');"],
      env: fixtureEnv(dir),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      requireProcessTreeExit: true,
      onReady(child) {
        [child.stdout!, child.stderr!].forEach((pipe, index) => {
          pipe.on("data", (chunk) => {
            output[index] += String(chunk);
          });
          pipe.once("close", () => {
            closed[index] = true;
          });
        });
      },
    });
    expect(code).toBe(0);
    expect(output).toEqual(["out", "err"]);
    expect(closed).toEqual([true, true]);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  posixIt("fails bounded cleanup when a timed-out child omits close", async () => {
    const root = createTempDir("openclaw-managed-child-missing-close-");
    const owner = createVitestResourceOwner(root);
    const startedAt = Date.now();
    let childPid = 0;
    await expect(
      runNodeCommand({
        args: ["-e", "setInterval(() => {}, 1_000)"],
        env: fixtureEnv(root),
        onReady: (child) => {
          childPid = expectProcessPid(child.pid);
          child.removeAllListeners("close");
        },
        timeoutMs: 200,
        timeoutKillGraceMs: 0,
        cleanupDrainTimeoutMs: 100,
      }),
    ).rejects.toMatchObject({
      code: "EPROCESSGROUP_CLEANUP_FAILED",
      processTreeState: "indeterminate",
    });

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(isProcessAlive(childPid)).toBe(false);
    expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
  });

  posixIt.for(["before", "after"])(
    "applies the strict wall deadline only before output closure (deadline %s close)",
    joinedCase(async (deadline, { signal }) => {
      const dir = fs.realpathSync(createTempDir("openclaw-managed-deadline-"));
      const helperUrl = managedModuleUrl;
      // Only this controller mocks time; child I/O and concurrent tests keep real clocks.
      const controllerPath = writeFixture(
        dir,
        "controller.mjs",
        `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { mock } from "node:test";

const [role, helperUrl, deadline] = process.argv.slice(2);
const file = (name) => new URL(name, import.meta.url);
if (role === "leaf") {
  const timer = setInterval(() => {
    if (fs.existsSync(file("release"))) clearInterval(timer);
  }, 5);
  process.send("ready");
  process.disconnect();
} else if (role === "leader") {
  const child = spawn(process.execPath, [import.meta.filename, "leaf", helperUrl], {
    detached: true,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  fs.writeFileSync(file("leaf.pid"), String(child.pid));
  child.once("message", () => process.exit(0));
} else {
  const { inspectManagedProcessGroup, runManagedCommand } = await import(helperUrl);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    let child, exited, closed;
    const result = runManagedCommand({
      bin: process.execPath,
      args: [import.meta.filename, "leader", helperUrl],
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 1_000,
      requireProcessTreeExit: true,
      onReady(owned) {
        child = owned;
        fs.writeFileSync(file("leader.pid"), String(child.pid));
        exited = once(child, "exit");
        closed = once(child, "close");
      },
    }).catch((error) => error.code);
    await exited;
    await new Promise(setImmediate);
    assert.equal(child.exitCode, 0);
    assert.equal(inspectManagedProcessGroup(child, { errorPolicy: "indeterminate" }), "dead");
    assert.equal(child.stdout.closed, false);
    assert.equal(child.stderr.closed, false);
    mock.timers.tick(deadline === "before" ? 1_000 : 975);
    fs.writeFileSync(file("release"), "release");
    await closed;
    mock.timers.tick(25);
    const outcome = await result;
    console.log(JSON.stringify({ outcome, stdoutClosed: child.stdout.closed, stderrClosed: child.stderr.closed }));
    assert.equal(outcome, deadline === "before" ? "ETIMEDOUT" : 0);
  } finally {
    mock.timers.reset();
  }
}
`,
      );
      const controller = spawn(
        process.execPath,
        [controllerPath, "controller", helperUrl, deadline],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const closed = waitForClose(controller);
      let stderr = "";
      controller.stderr!.on("data", (chunk) => {
        stderr += String(chunk);
      });
      await runQaGatewayFixture(
        async () => {
          expect(await withinTest(closed, signal), stderr).toEqual({ code: 0, signal: null });
        },
        () => {
          if (controller.exitCode === null && controller.signalCode === null) {
            controller.kill("SIGKILL");
          }
        },
        () => closed,
        ...["leader", "leaf"].map((role) => async () => {
          const pidPath = path.join(dir, `${role}.pid`);
          if (fs.existsSync(pidPath)) {
            await killFixturePid(Number(fs.readFileSync(pidPath, "utf8")), signal, true);
          }
        }),
      );
    }),
  );

  async function runEscapedOutputFixture(
    mode: string,
    expectCase: typeof expect,
    signal: AbortSignal,
    {
      bin = process.execPath,
      onJoined,
      beforeReadinessFailure,
      dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "openclaw-managed-held-output-"),
      ),
    }: {
      bin?: string;
      dir?: string;
      onJoined?: () => void;
      beforeReadinessFailure?: Promise<void>;
    } = {},
  ) {
    // Concurrent rows own their roots; the shared afterEach can run while a sibling is alive.
    // This namespace owns the deliberate failed join and manual rescue. Pass
    // it explicitly so concurrent rows never mutate shared worker environment.
    const owner = createVitestResourceOwner(dir);
    const env = fixtureEnv(dir);
    const pidPath = path.join(dir, "escaped.pid");
    const parentPidPath = path.join(dir, "parent.pid");
    const failPath = path.join(dir, "fail");
    const normalExit = mode === "normal exit" || mode === "normal drainage";
    const leaf = `
import fs from 'node:fs';
${fixtureReceiptClientSource(receipts.endpoint)}
process.on('SIGTERM', () => {});
const keepAlive = setInterval(() => {
  if (${mode === "normal drainage"} && fs.existsSync(${JSON.stringify(failPath)})) {
    clearInterval(keepAlive);
    process.stdout.write('drained-out');
    process.stderr.write('drained-err');
  }
}, ${mode === "normal drainage" ? 5 : 1000});
// The watchdog may kill the parent as soon as readiness is published.
process.once('disconnect', () => {
  fs.writeFileSync(${JSON.stringify(pidPath)} + '.tmp', String(process.pid));
  fs.renameSync(${JSON.stringify(pidPath)} + '.tmp', ${JSON.stringify(pidPath)});
  sendReceipt(${JSON.stringify(pidPath)}, "ready");
});
process.send('ready');
process.disconnect();
`;
    const args = [
      "-e",
      `
require('node:fs').writeFileSync(${JSON.stringify(parentPidPath)}, String(process.pid));
const child = require('node:child_process').spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(leaf)}], { detached: true, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
child.once('message', () => { ${normalExit ? "process.exit(0);" : ""} });
`,
    ];
    let child: ReturnType<typeof spawn> | undefined;
    let childClosed: Promise<unknown> | undefined;
    const childExited = createDeferred();
    let escapedPid = 0;
    let exitedAt = 0;
    let settledAt = 0;
    let output = { stdout: "", stderr: "" };
    const abortController = new AbortController();
    let outcome!: Promise<
      { status: "fulfilled"; value: number | void } | { status: "rejected"; error: unknown }
    >;
    let outcomeAsserted = false;
    const releaseAndWait = startProcessWatchdogFixture(() => {
      const command =
        mode !== "sibling failure"
          ? runManagedCommand({
              bin,
              args,
              env,
              stdio: ["ignore", "pipe", "pipe"],
              timeoutMs: mode === "timeout" ? 100 : undefined,
              // This row verifies the full pipe-drain budget, not the default TERM grace.
              timeoutKillGraceMs: 100,
              requireProcessTreeExit: normalExit,
              signal: abortController.signal,
              onReady: (owned) => {
                child = owned;
                childClosed = waitForClose(child);
                output = captureOutput(child);
                child.once("exit", () => {
                  exitedAt = Date.now();
                  childExited.resolve();
                });
              },
            })
          : runNodeStepsInParallel([
              { label: "blocked", bin, args, env, timeoutMs: 100, abortKillGraceMs: 100 },
              {
                label: "primary",
                env,
                args: [
                  "-e",
                  `setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(failPath)})) process.exit(2); }, 5);`,
                ],
                timeoutMs: 30_000,
              },
            ]);
      // Observe sibling cancellation without releasing the blocked watchdog.
      outcome = command
        .then(
          (value) => ({ status: "fulfilled" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        )
        .finally(() => {
          settledAt = Date.now();
        });
      return outcome;
    });
    const readinessOutcome = outcome.then(async (result) => {
      onJoined?.();
      await beforeReadinessFailure;
      return result;
    });
    await runQaGatewayFixture(
      async () => {
        escapedPid = await readyPid(pidPath, readinessOutcome, signal);
        // The parent commits its PID before spawning the leaf whose ready receipt we joined.
        const parentPid = Number(fs.readFileSync(parentPidPath, "utf8"));
        expectCase(Number.isSafeInteger(parentPid) && parentPid > 0).toBe(true);
        const canceledAt = Date.now();
        if (mode === "normal drainage") {
          await joinGate(childExited.promise, outcome, signal);
          expectCase(child).toMatchObject({
            exitCode: 0,
            stdout: { closed: false },
            stderr: { closed: false },
          });
          expectCase(settledAt).toBe(0);
          fs.writeFileSync(failPath, "drain");
        }
        if (mode === "sibling failure") {
          fs.writeFileSync(failPath, "fail");
        } else if (mode === "timeout") {
          await withinTest(releaseAndWait(), signal);
        } else {
          await withinTest(outcome, signal);
        }
        const result = await withinTest(outcome, signal);
        const failure = result.status === "rejected" ? result.error : result.value;
        const cleanupFailure = {
          code: "EPROCESSGROUP_CLEANUP_FAILED",
          processTreeState: "indeterminate",
        };
        if (mode === "normal drainage") {
          expectCase(failure).toBe(0);
          outcomeAsserted = true;
          expectCase(output).toEqual({ stdout: "drained-out", stderr: "drained-err" });
          expectCase(child).toMatchObject({ stdout: { closed: true }, stderr: { closed: true } });
        } else if (mode !== "sibling failure") {
          expectCase(failure).toMatchObject(cleanupFailure);
          outcomeAsserted = true;
          expectCase(child).toMatchObject({
            stdout: { destroyed: true },
            stderr: { destroyed: true },
          });
          if (mode === "normal exit") {
            expectCase(child?.exitCode).toBe(0);
            expectCase(settledAt - exitedAt).toBeGreaterThanOrEqual(5_000);
            expectCase(settledAt - exitedAt).toBeLessThan(7_000);
          }
        } else {
          expectCase(failure).toBeInstanceOf(AggregateError);
          expectCase(failure).toMatchObject({
            message: "primary failed with exit code 2; sibling cleanup could not be verified",
            errors: [{ message: "primary failed with exit code 2" }, cleanupFailure],
          });
          outcomeAsserted = true;
        }
        expectCase(Date.now() - canceledAt).toBeLessThan(12_000);
        expectCase(isProcessAlive(parentPid)).toBe(false);
        if (mode === "normal drainage") {
          await waitForFixtureDead(escapedPid, signal);
        }
        expectCase(isProcessAlive(escapedPid)).toBe(mode !== "normal drainage");
        if (mode === "normal drainage") {
          expectCase(() => owner.assertReleased()).not.toThrow();
        } else {
          expectCase(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        }
      },
      () => fs.writeFileSync(failPath, "fail"),
      () => abortController.abort(),
      async () => {
        const result = await releaseAndWait();
        // A readiness/body failure must retain the command's rejection too.
        // Expected errors are consumed only after their assertions succeed; 0 stays success.
        if (!outcomeAsserted && result.status === "rejected") {
          throw result.error;
        }
      },
      async () => {
        // Attempt both rescues, but retain PID evidence if either process cannot be joined.
        await runQaGatewayFixture(
          async () => {
            if (!escapedPid && fs.existsSync(pidPath)) {
              escapedPid = Number(fs.readFileSync(pidPath, "utf8"));
            }
            if (escapedPid && isProcessAlive(escapedPid)) {
              process.kill(escapedPid, "SIGKILL");
              await waitForFixtureDead(escapedPid, signal);
            }
          },
          async () => {
            if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
              child.kill("SIGKILL");
              await childClosed;
            }
          },
        );
        fs.rmSync(dir, { recursive: true, force: true });
      },
    );
  }

  posixIt.concurrent.for(["timeout", "sibling failure", "normal exit", "normal drainage"])(
    "joins escaped output or fails closed within the cleanup budget after $0",
    { timeout: 25_000 },
    joinedCase(async (mode, { expect: expectCase, signal }) => {
      await runEscapedOutputFixture(mode, expectCase, signal);
    }),
  );

  posixIt.for(["timeout", "sibling failure"])(
    "retains escaped-output launch diagnostics when PID readiness fails ($0)",
    { timeout: 25_000 },
    joinedCase(async (mode, { expect: expectCase, signal }) => {
      const dir = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "openclaw-escaped-launch-failure-"),
      );
      const bin = path.join(dir, "missing-node");
      const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
      const listeners = signals.map((forwarded) => process.listenerCount(forwarded));
      const observedRelease = createDeferred();
      const commandsJoined = createDeferred();
      const completion = runEscapedOutputFixture(mode, expectCase, signal, {
        bin,
        dir,
        onJoined: () => commandsJoined.resolve(),
        beforeReadinessFailure: observedRelease.promise,
      }).catch((error: unknown) => error);
      const owner = findVitestResourceOwner(dir);
      await runQaGatewayFixture(
        async () => {
          if (!owner) {
            throw new Error("Expected escaped-output fixture resource owner");
          }
          // The parallel path also starts a real sibling. Verify every command
          // released its claim while the fixture still holds its PID evidence.
          await joinGate(commandsJoined.promise, completion, signal);
          // All sibling command outcomes settle after releasing their resource claims.
          owner.assertReleased();
        },
        async () => {
          // Keep PID evidence until the release assertion has observed the real command join.
          observedRelease.resolve();
          const failure = await completion;
          expectCase(fs.existsSync(dir)).toBe(false);
          expectCase(signals.map((forwarded) => process.listenerCount(forwarded))).toEqual(
            listeners,
          );
          const errors: unknown[] = failure instanceof AggregateError ? failure.errors : [failure];
          expectCase(errors).toEqual(
            expectCase.arrayContaining([
              expectCase.objectContaining({
                message: `timeout waiting for pid in ${path.join(dir, "escaped.pid")}`,
              }),
              expectCase.objectContaining({ code: "ENOENT", path: bin, syscall: `spawn ${bin}` }),
            ]),
          );
        },
      );
    }),
  );

  posixIt.each(["indeterminate", "vanished"] as const)(
    "joins a child after a transient %s group observation",
    async (mode) => {
      const originalKill = process.kill.bind(process);
      let childPid = 0;
      let injected = false;
      const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -childPid && signal === 0 && !injected) {
          injected = true;
          if (mode === "indeterminate") {
            throw Object.assign(new Error("transient process-group state"), { code: "EPERM" });
          }
          return true;
        }
        return originalKill(pid, signal);
      });
      try {
        const outcome = runNodeCommand({
          args: [
            "-e",
            mode === "indeterminate" ? "setInterval(() => {}, 1_000)" : "process.exit(0)",
          ],
          onReady: (child) => {
            childPid = expectProcessPid(child.pid);
          },
          requireProcessTreeExit: mode === "vanished",
          timeoutMs: mode === "indeterminate" ? 200 : 1_000,
        });
        if (mode === "indeterminate") {
          await expect(outcome).rejects.toMatchObject({ code: "ETIMEDOUT" });
        } else {
          await expect(outcome).resolves.toBe(0);
        }
      } finally {
        kill.mockRestore();
      }
      expect({ injected, alive: isProcessAlive(childPid) }).toEqual({
        injected: true,
        alive: false,
      });
    },
  );

  it("allows bounded retry output to complete", async () => {
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: [
          "-e",
          "process.stderr.write('network retry 1\\n'); setTimeout(() => process.exit(0), 100)",
        ],
        shell: false,
        stdio: "ignore",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(0);
  });

  posixIt("allows strict normal long-running work to complete", async () => {
    await expect(
      runManagedCommand({
        bin: process.execPath,
        args: ["-e", "setTimeout(() => process.exit(0), 200)"],
        requireProcessTreeExit: true,
        shell: false,
        stdio: "ignore",
        timeoutMs: 1_000,
      }),
    ).resolves.toBe(0);
  });

  it("cleans up the child when onReady throws", async () => {
    let childPid = 0;
    await expect(
      runNodeCommand({
        args: ["-e", "setInterval(() => {}, 1_000)"],
        onReady: (child) => {
          childPid = expectProcessPid(child.pid);
          throw new Error("setup failed");
        },
      }),
    ).rejects.toThrow("setup failed");
    expect(isProcessAlive(childPid)).toBe(false);
  });

  posixIt.each([
    { first: "abort", setupFails: false, cleanupFails: false },
    { first: "signal", setupFails: false, cleanupFails: false },
    { first: "abort", setupFails: true, cleanupFails: false },
    { first: "abort", setupFails: true, cleanupFails: true },
  ])(
    "joins reentrant $first cancellation (setup failure: $setupFails, cleanup failure: $cleanupFails)",
    async ({ first, setupFails, cleanupFails }) => {
      const dir = createTempDir("openclaw-managed-reentrant-");
      // Deliberate failed finalization owns a separate namespace; the controller
      // joins its real child before this fixture is removed.
      createVitestResourceOwner(dir);
      runController(
        dir,
        `
import assert from 'node:assert/strict';
import { runManagedCommand } from ${JSON.stringify(managedModuleUrl)};
const controller = new AbortController();
const setupError = new Error('setup failed');
const cleanupError = new Error('taskkill failed synchronously');
const first = ${JSON.stringify(first)};
const setupFails = ${setupFails};
const cleanupFails = ${cleanupFails};
let child, closed;
let terminations = 0;
const kill = process.kill.bind(process);
process.kill = (pid, signal) => {
  if (signal && pid === -child?.pid) {
    terminations++;
  }
  return kill(pid, signal);
};
const outcome = await runManagedCommand({
  bin: process.execPath,
  args: ['-e', 'setTimeout(() => process.exit(73), 5000)'],
  shell: false,
  stdio: 'ignore',
  signal: controller.signal,
  platform: cleanupFails ? 'win32' : process.platform,
  runTaskkill() {
    terminations++;
    child.kill('SIGKILL');
    throw cleanupError;
  },
  onReady(owned) {
    child = owned;
    closed = new Promise(resolve => child.once('close', resolve));
    const cancel = kind => kind === 'abort' ? controller.abort() : process.emit('SIGTERM');
    cancel(first);
    assert.equal(terminations, 1, 'cancellation must initiate termination synchronously');
    cancel(first === 'abort' ? 'signal' : 'abort');
    assert.equal(terminations, 1, 'reentrant cancellation must reuse finalization');
    if (setupFails) {
      throw setupError;
    }
  },
}).catch(error => error);
await closed;
assert.throws(() => kill(child.pid, 0));
assert.equal(terminations, 1, 'setup failure must also join the same finalizer');
if (cleanupFails) {
  assert.ok(outcome instanceof AggregateError);
  assert.deepEqual(outcome.errors, [setupError, cleanupError]);
  assert.equal(outcome.cause, cleanupError);
} else if (setupFails) {
  assert.equal(outcome, setupError);
} else if (first === 'abort') {
  assert.equal(outcome.code, 'ABORT_ERR');
} else {
  assert.equal(outcome, 143);
}
`,
        process.execPath,
        false,
      );
    },
  );

  posixIt.for([
    { runner: "managed", output: "ignore", exit: 0 },
    { runner: "managed", output: "inherit", exit: 0 },
    { runner: "preparation", output: "ignore", exit: 0 },
    { runner: "preparation", output: "inherit", exit: 0 },
    { runner: "managed", output: "pipe", exit: 143 },
    { runner: "managed", output: "pipe", exit: "SIGTERM" },
  ] as const)(
    "joins descendants after $runner leader exits $exit ($output output)",
    joinedCase(async ({ runner, output, exit }, { signal }) => {
      const dir = createTempDir("openclaw-managed-lingering-");
      const owner = createVitestResourceOwner(dir);
      const env = fixtureEnv(dir);
      const descendantPidPath = path.join(dir, "descendant.pid");
      const receivedSignalPath = path.join(dir, "descendant.signal");
      const leafOutput = output === "ignore" ? "ignore" : "inherit";
      const leaf = `
const fs = require("node:fs");
const keepAlive = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  fs.writeFileSync(process.argv[2], "SIGTERM");
  process.stdout.write("descendant stdout drained\\n");
  process.stderr.write("descendant stderr drained\\n");
  clearInterval(keepAlive);
});
fs.writeFileSync(process.argv[1], String(process.pid));
process.send("ready");
process.disconnect();
`;
      const args = [
        "-e",
        `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [
  "-e", ${JSON.stringify(leaf)}, process.argv[1], process.argv[2],
], { stdio: ["ignore", ${JSON.stringify(leafOutput)}, ${JSON.stringify(leafOutput)}, "ipc"] });
child.once("message", () => ${typeof exit === "string" ? `process.kill(process.pid, ${JSON.stringify(exit)})` : `process.exit(${exit})`});
`,
        descendantPidPath,
        receivedSignalPath,
      ];
      const onSignal = vi.fn();
      let child: ReturnType<typeof spawn> | undefined;
      let captured = { stdout: "", stderr: "" };
      try {
        const command =
          runner === "preparation"
            ? runNodeStep("lingering-prep", args, 1_000, { env })
            : runNodeCommand({
                args,
                env,
                onSignal,
                requireProcessTreeExit: true,
                stdio: output === "pipe" ? ["ignore", "pipe", "pipe"] : output,
                timeoutMs: 1_000,
                onReady(owned) {
                  child = owned;
                  captured = captureOutput(child);
                },
              });
        const outcome = await command.catch((error: unknown) => error);
        const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        if (typeof exit === "string") {
          expect(outcome).toBe(143);
          expect(fs.readFileSync(receivedSignalPath, "utf8")).toBe("SIGTERM");
        } else if (output !== "ignore") {
          // Open descendant output keeps the original command timeout active
          // while the group drains; its cancellation must precede forced cleanup.
          const timeout = {
            code: "ETIMEDOUT",
            message: "Managed command timed out after 1000ms",
          };
          expect
            .soft(outcome)
            .toMatchObject(
              runner === "preparation"
                ? { message: "lingering-prep timed out after 1000ms", cause: timeout }
                : timeout,
            );
          expect(fs.readFileSync(receivedSignalPath, "utf8")).toBe("SIGTERM");
        } else {
          expect.soft(outcome).toMatchObject({
            code: "EPROCESSGROUP_CLEANUP_FAILED",
            processTreeState: "terminated",
          });
          expect(fs.existsSync(receivedSignalPath)).toBe(false);
        }
        if (typeof exit === "string" || (output !== "ignore" && runner === "managed")) {
          expect(captured).toEqual({
            stdout: "descendant stdout drained\n",
            stderr: "descendant stderr drained\n",
          });
          expect(child).toMatchObject({ stdout: { closed: true }, stderr: { closed: true } });
        }
        expect(onSignal).not.toHaveBeenCalled();
        expect(() => owner.assertReleased()).not.toThrow();
        expect
          .soft(
            isProcessAlive(descendantPid),
            `descendant ${descendantPid} must be absent at settlement`,
          )
          .toBe(false);
      } finally {
        // Recover the recorded PID even when an unexpected success fails the assertion.
        if (fs.existsSync(descendantPidPath)) {
          const descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
          if (Number.isSafeInteger(descendantPid) && descendantPid > 1) {
            if (isProcessAlive(descendantPid)) {
              process.kill(descendantPid, "SIGKILL");
            }
            await waitForFixtureDead(descendantPid, signal);
          }
        }
      }
    }),
  );

  posixIt("releases non-strict command claims after a child signal exit", async () => {
    const dir = createTempDir("openclaw-managed-signal-");
    const owner = createVitestResourceOwner(dir);
    const onSignal = vi.fn();
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "";
    const code = await runNodeCommand({
      args: [
        "-e",
        "require('node:fs').writeSync(1, 'signal output\\n'); process.kill(process.pid, 'SIGTERM');",
      ],
      env: fixtureEnv(dir),
      stdio: ["ignore", "pipe", "pipe"],
      onSignal,
      onReady(owned) {
        child = owned;
        expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
        child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      },
    });
    expect(code).toBe(143);
    expect(onSignal).not.toHaveBeenCalled();
    expect(stdout).toBe("signal output\n");
    expect(child?.signalCode).toBe("SIGTERM");
    expect(child?.stdout?.closed).toBe(true);
    expect(child?.stderr?.closed).toBe(true);
    expect(() => owner.assertReleased()).not.toThrow();
  });

  posixIt(
    "kills managed child process group descendants when the runner is terminated",
    joinedTest(async ({ signal }) => {
      const dir = createTempDir("openclaw-managed-child-");
      const childPidPath = path.join(dir, "child.pid");
      const descendantPidPath = path.join(dir, "descendant.pid");
      const helperUrl = managedModuleUrl;

      const childPath = writeFixture(
        dir,
        "child.mjs",
        `
	import { spawn } from "node:child_process";
	import fs from "node:fs";
${fixtureReceiptClientSource(receipts.endpoint)}

	const descendant = spawn(process.execPath, [
	  "-e",
	  ${JSON.stringify(`
const fs = require("node:fs");
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
${publishReadyPidScript(1)}
process.send("ready");
`)},
	  process.argv[3],
	], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  descendant.once("message", () => sendReceipt(process.argv[3], "ready"));
	for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
	  process.on(signal, () => process.exit(0));
	}
setInterval(() => {}, 1_000);
${publishReadyPidScript(2)}
sendReceipt(process.argv[2], "ready");
`,
      );
      const runnerPath = writeFixture(
        dir,
        "runner.mjs",
        `
import { runManagedCommand } from ${JSON.stringify(helperUrl)};

	process.exitCode = await runManagedCommand({
	  bin: process.execPath,
	  args: [${JSON.stringify(childPath)}, ${JSON.stringify(childPidPath)}, ${JSON.stringify(descendantPidPath)}],
	  stdio: "ignore",
	  onReady: () => process.send("ready"),
	});
`,
      );

      const runner = spawn(process.execPath, [runnerPath], {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      const closed = waitForClose(runner);
      const ready = createDeferred();
      runner.once("message", () => ready.resolve());
      const runnerPid = expectProcessPid(runner.pid);
      let childPid = 0;
      let descendantPid = 0;

      try {
        await joinGate(ready.promise, closed, signal);
        childPid = await readyPid(childPidPath, closed, signal);
        descendantPid = await readyPid(descendantPidPath, closed, signal);
        expect(Number.isInteger(childPid)).toBe(true);
        expect(Number.isInteger(descendantPid)).toBe(true);
        expect(isProcessAlive(childPid)).toBe(true);
        expect(isProcessAlive(descendantPid)).toBe(true);

        process.kill(runnerPid, "SIGTERM");
        const result = await withinTest(closed, signal);

        expect(result).toEqual({ code: 143, signal: null });
        // Signal finalization joins the owned group before the runner returns its exit code.
        expect(isProcessAlive(childPid)).toBe(false);
        await waitForFixtureDead(descendantPid, signal);
        expect(isProcessAlive(descendantPid)).toBe(false);
      } finally {
        if (!childPid && fs.existsSync(childPidPath)) {
          childPid = Number(fs.readFileSync(childPidPath, "utf8"));
        }
        if (!descendantPid && fs.existsSync(descendantPidPath)) {
          descendantPid = Number(fs.readFileSync(descendantPidPath, "utf8"));
        }
        if (isProcessAlive(runnerPid)) {
          process.kill(runnerPid, "SIGKILL");
        }
        if (childPid && isProcessAlive(childPid)) {
          process.kill(childPid, "SIGKILL");
        }
        if (descendantPid && isProcessAlive(descendantPid)) {
          process.kill(descendantPid, "SIGKILL");
        }
        await closed;
      }
    }),
  );
});

// Orphaned fixture PIDs have no ChildProcess event; their former owner has already joined.
async function waitForFixtureDead(pid: number, signal: AbortSignal) {
  while (isPidAlive(pid)) {
    if (signal.aborted) {
      throw new Error(`process still alive: ${pid}`, { cause: signal.reason });
    }
    await delay(5, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`process still alive: ${pid}`, { cause: error });
    });
  }
}

async function waitForClose(child: ReturnType<typeof spawn>) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}
