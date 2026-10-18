import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { expect, it, vi } from "vitest";
import {
  checkKnipUnusedFileScanResult,
  checkUnusedFiles,
  parseKnipCompactUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mts";
import { KNIP_MAX_BUFFER_BYTES, runKnip } from "../../scripts/deadcode-knip-runner.mts";
import { killPidIfAlive } from "../../src/test-utils/process-tree.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { startProcessWatchdogFixture } from "../helpers/process-watchdog.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

const KNIP_UNUSED_FILE_ARGS =
  "--config config/knip.config.ts --production --no-progress --reporter compact --files --no-config-hints".split(
    " ",
  );
const KNIP_UNUSED_FILE_SCAN_NAME = "production unused-file scan";
const FAKE_KNIP_KILL_GRACE_MS = 50;

class FakeKnipProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  pid = 12345;
}

function runFakeKnip(child: FakeKnipProcess, options: Parameters<typeof runKnip>[1] = {}) {
  return runKnip(KNIP_UNUSED_FILE_ARGS, {
    spawnCommand: () => child,
    writeStatus: () => {},
    ...options,
  });
}

function knipResult(overrides: Partial<Awaited<ReturnType<typeof runKnip>>>) {
  return {
    errorCode: undefined,
    errorMessage: undefined,
    output: "",
    signal: null,
    status: 0,
    ...overrides,
  };
}

function finishFakeProcess(
  child: FakeKnipProcess,
  status: number | null,
  signal: NodeJS.Signals | null,
): void {
  // Real child termination cannot reenter process.kill before its caller returns.
  queueMicrotask(() => {
    child.emit("exit", status, signal);
    child.emit("close", status, signal);
  });
}

type ProcessKillSignal = Parameters<typeof process.kill>[1];

async function withFakeProcessSignals(
  child: FakeKnipProcess,
  run: (kills: ProcessKillSignal[]) => Promise<void>,
) {
  const originalKill = process.kill.bind(process);
  const kills: ProcessKillSignal[] = [];
  const restoredSignals: ProcessKillSignal[] = [];
  let restored = false;
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (Math.abs(pid) !== child.pid) {
      return originalKill(pid, signal);
    }
    if (restored) {
      restoredSignals.push(signal);
    }
    if (signal === 0) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    if (!restored) {
      kills.push(signal);
      finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
    }
    return true;
  });
  try {
    await run(kills);
  } finally {
    // Keep fake PIDs away from the OS until every grace callback has run, even on failure.
    restored = true;
    try {
      await waitForProcessTick(FAKE_KNIP_KILL_GRACE_MS);
      expect(restoredSignals, "signaling survived process.kill mock restoration").toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  }
}

// Parent signal forwarding kills the group without joining foreign descendants.
async function waitForDescendantExit(pid: number, signal: AbortSignal): Promise<void> {
  while (isProcessAlive(pid)) {
    await waitForProcessTick(5, undefined, { signal }).catch((cause: unknown) => {
      throw new Error(`process still alive: ${pid}`, { cause });
    });
  }
}

it("parses the compact Knip unused-file section", () => {
  expect(
    parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts
C:\\tmp\\outside.ts: C:\\tmp\\outside.ts
C:outside.ts: C:outside.ts
\\\\server\\share\\outside.ts: \\\\server\\share\\outside.ts

Unused dependencies (1)
left-pad: package.json
`),
  ).toEqual(["src/a.ts", "src/b.ts"]);
});

it("accepts an empty compact report with zero unused files", () => {
  expect(checkUnusedFiles("")).toStrictEqual({ files: [], ok: true, message: "" });
});

it("rejects a nonzero Knip exit even when no unused files were printed", () => {
  expect(checkKnipUnusedFileScanResult(knipResult({ status: 2 }))).toStrictEqual({
    failureReason: "exit status 2",
    message: "",
    ok: false,
  });
});

it("rejects every unused file without an allowlist", () => {
  expect(
    checkUnusedFiles("Unused files (2)\nsrc/z.ts: src/z.ts\nsrc/a.ts: src/a.ts\n"),
  ).toStrictEqual({
    files: ["src/a.ts", "src/z.ts"],
    ok: false,
    message: `Unused files are not allowed:
  src/a.ts
  src/z.ts
Delete the files or model their real entrypoints in Knip.`,
  });
});

it("runs Knip through a process-group-aware subprocess", async ({ onTestFinished }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-runner-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const pnpmExecPath = path.join(root, "pnpm.cjs");
  writeFileSync(pnpmExecPath, "console.log('pnpm');\n", "utf8");
  const child = new FakeKnipProcess();
  const spawnCommand = vi.fn(() => child);
  const resultPromise = runFakeKnip(child, {
    nodeExecPath: "/test-node",
    npmExecPath: pnpmExecPath,
    spawnCommand,
  });
  child.stdout.emit("data", "partial stdout");
  child.stderr.emit("data", "partial stderr");
  finishFakeProcess(child, 0, null);

  expect(spawnCommand).toHaveBeenCalledExactlyOnceWith(
    "/test-node",
    [
      pnpmExecPath,
      ..."dlx --package knip@6.40.0 knip --config config/knip.config.ts --production --no-progress --reporter compact --files --no-config-hints".split(
        " ",
      ),
    ],
    expect.objectContaining({
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  await expect(resultPromise).resolves.toStrictEqual(
    knipResult({ output: "partial stdoutpartial stderr" }),
  );
});

it.each([
  ["timeout", "ETIMEDOUT", "", "Knip production unused-file scan timed out"],
  ["output cap", "ENOBUFS", "too ", "Knip production unused-file scan exceeded 4 output bytes"],
])(
  "reports Knip %s and signals its process group",
  async (kind, errorCode, output, errorMessage) => {
    const statuses: string[] = [];
    const child = new FakeKnipProcess();
    await withFakeProcessSignals(child, async (kills) => {
      const timeout = kind === "timeout";
      const result = runFakeKnip(child, {
        ...(timeout ? { heartbeatMs: 1 } : {}),
        killGraceMs: FAKE_KNIP_KILL_GRACE_MS,
        maxBufferBytes: timeout ? KNIP_MAX_BUFFER_BYTES : 4,
        scanName: KNIP_UNUSED_FILE_SCAN_NAME,
        timeoutMs: timeout ? 5 : 1000,
        writeStatus: (message: string) => statuses.push(message),
      });
      if (!timeout) {
        child.stdout.emit("data", "too much output");
      }
      await expect(result).resolves.toStrictEqual(
        knipResult({
          errorCode,
          errorMessage: timeout ? expect.stringContaining(errorMessage) : errorMessage,
          output,
          signal: "SIGTERM",
          status: null,
        }),
      );
      if (timeout) {
        expect(statuses.some((message) => message.includes("still running"))).toBe(true);
        expect(statuses.some((message) => message.includes("timed out"))).toBe(true);
      }
      expect(kills).toEqual(["SIGTERM"]);
    });
  },
);

it.skipIf(process.platform === "win32").for(["timeout", "parent SIGTERM"])(
  "cleans Knip descendants after %s",
  async (mode, { signal }) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-group-"));
    const childPidPath = path.join(root, "child.pid");
    const scriptUrl = pathToFileURL(path.resolve("scripts/deadcode-knip-runner.mts")).href;
    let childPid = 0;
    let runner: ReturnType<typeof spawn> | undefined;
    const ready = createDeferred<number>();
    let operation!: Promise<unknown>;
    let releaseAndWait: (() => ReturnType<typeof runKnip>) | undefined;

    try {
      const childScript = [
        "process.on('SIGTERM', () => {});",
        "process.send(process.pid);",
        "setInterval(() => {}, 1000);",
      ].join("");
      const parentScript = [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
        `child.once('message', (pid) => { fs.writeFileSync(${JSON.stringify(childPidPath)}, String(pid)); process.send(pid); });`,
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("");
      if (mode === "timeout") {
        releaseAndWait = startProcessWatchdogFixture(() => {
          const result = runKnip(KNIP_UNUSED_FILE_ARGS, {
            killGraceMs: 50,
            timeoutMs: 100,
            writeStatus: () => {},
            spawnCommand(_command, _args, options) {
              const parent = spawn(process.execPath, ["-e", parentScript], {
                ...options,
                stdio: ["ignore", "pipe", "pipe", "ipc"],
              });
              parent.once("message", (pid: number) => ready.resolve(pid));
              return parent;
            },
          });
          operation = result;
          return result;
        });
      } else {
        const runnerScript = [
          "import { spawn } from 'node:child_process';",
          `import { runKnip } from ${JSON.stringify(scriptUrl)};`,
          `await runKnip(${JSON.stringify(KNIP_UNUSED_FILE_ARGS)}, {`,
          "  spawnCommand(_command, _args, options) {",
          `    const parent = spawn(process.execPath, ['-e', ${JSON.stringify(parentScript)}], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });`,
          "    parent.once('message', (pid) => process.send(pid));",
          "    return parent;",
          "  },",
          "  timeoutMs: 60_000,",
          "  writeStatus: () => {},",
          "});",
        ].join("\n");

        runner = spawn(process.execPath, ["--input-type=module", "-e", runnerScript], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        operation = once(runner, "close");
        runner.once("message", (pid: number) => ready.resolve(pid));
      }
      childPid = await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          operation,
          `timeout waiting for pid in ${childPidPath}`,
        ),
        signal,
      );
      expect(isProcessAlive(childPid)).toBe(true);
      if (releaseAndWait) {
        await expect(withinTest(releaseAndWait(), signal)).resolves.toMatchObject({
          errorCode: "ETIMEDOUT",
        });
        // Timeout teardown must finish before runKnip resolves.
        expect(isProcessAlive(childPid)).toBe(false);
      } else {
        runner?.kill("SIGTERM");
        await expect(withinTest(operation, signal)).resolves.toEqual([null, "SIGTERM"]);
        await waitForDescendantExit(childPid, signal);
      }
    } finally {
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGTERM");
      }
      await releaseAndWait?.();
      if (!childPid && existsSync(childPidPath)) {
        childPid = Number(readFileSync(childPidPath, "utf8"));
      }
      killPidIfAlive(childPid || undefined);
      await operation;
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("keeps output delivered after process exit but before stdio close", async () => {
  const child = new FakeKnipProcess();
  const resultPromise = runFakeKnip(child);

  child.stdout.emit("data", "before-exit\n");
  child.emit("exit", 0, null);
  child.stdout.emit("data", "after-exit\n");
  child.emit("close", 0, null);

  await expect(resultPromise).resolves.toStrictEqual(
    knipResult({ output: "before-exit\nafter-exit\n" }),
  );
});

it.each([
  ["interleaved UTF-8", 8, "🦞", "📦", 1, undefined, "🦞📦"],
  ["UTF-8 cut by byte cap", 4, "ab🦞", "", 4, "ENOBUFS", "ab"],
] as const)("preserves %s", async (_name, maxBufferBytes, out, err, split, errorCode, output) => {
  const child = new FakeKnipProcess();
  child.pid = 0;
  const resultPromise = runFakeKnip(child, { maxBufferBytes });
  const streams = [
    [child.stdout, Buffer.from(out)],
    [child.stderr, Buffer.from(err)],
  ] as const;
  for (const first of [true, false]) {
    for (const [stream, bytes] of streams) {
      if (bytes.length) {
        stream.emit("data", first ? bytes.subarray(0, split) : bytes.subarray(split));
      }
    }
  }
  const status = errorCode ? null : 0;
  const signal = errorCode ? "SIGTERM" : null;
  finishFakeProcess(child, status, signal);
  await expect(resultPromise).resolves.toMatchObject({ errorCode, output, signal, status });
});

it("reports spawn errors", async () => {
  const child = new FakeKnipProcess();
  const resultPromise = runFakeKnip(child);
  queueMicrotask(() =>
    child.emit("error", Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" })),
  );

  await expect(resultPromise).resolves.toStrictEqual(
    knipResult({
      errorCode: "ENOENT",
      errorMessage: "spawn pnpm ENOENT",
      status: null,
    }),
  );
});
