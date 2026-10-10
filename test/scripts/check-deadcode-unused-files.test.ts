// Check Deadcode Unused Files tests cover check deadcode unused files script behavior.
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
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

const KNIP_UNUSED_FILE_ARGS = [
  "--config",
  "config/knip.config.ts",
  "--production",
  "--no-progress",
  "--reporter",
  "compact",
  "--files",
  "--no-config-hints",
];
const KNIP_UNUSED_FILE_SCAN_NAME = "production unused-file scan";
const FAKE_KNIP_KILL_GRACE_MS = 50;

class FakeKnipProcess extends EventEmitter {
  readonly stderr = new EventEmitter();
  readonly stdout = new EventEmitter();
  pid = 12345;
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
): Promise<void> {
  const originalKill = process.kill.bind(process);
  const kills: ProcessKillSignal[] = [];
  const restoredSignals: ProcessKillSignal[] = [];
  const observer: typeof process.kill = (pid, signal) => {
    if (Math.abs(pid) !== child.pid) {
      return originalKill(pid, signal);
    }
    restoredSignals.push(signal);
    if (signal === 0) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    return true;
  };
  const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (Math.abs(pid) !== child.pid) {
      return observer(pid, signal);
    }
    if (signal === 0) {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }
    kills.push(signal);
    finishFakeProcess(child, null, (signal as NodeJS.Signals | undefined) ?? "SIGTERM");
    return true;
  });
  try {
    await run(kills);
  } finally {
    // Restore the inner mock to a safe observer until any grace callback has run.
    // Keep this guard even on assertion failure: fake PIDs must never reach the OS.
    killSpy.mockImplementation(observer);
    try {
      await new Promise((resolve) => {
        setTimeout(resolve, FAKE_KNIP_KILL_GRACE_MS);
      });
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

describe("check-deadcode-unused-files", () => {
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
    expect(checkUnusedFiles("")).toStrictEqual({
      files: [],
      ok: true,
      message: "",
    });
  });

  it("rejects a nonzero Knip exit even when no unused files were printed", () => {
    expect(
      checkKnipUnusedFileScanResult({
        errorCode: undefined,
        output: "",
        signal: null,
        status: 2,
      }),
    ).toStrictEqual({
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

  it("runs Knip through a process-group-aware subprocess", async () => {
    const calls: unknown[] = [];
    const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-runner-"));
    const pnpmExecPath = path.join(root, "pnpm.cjs");
    writeFileSync(pnpmExecPath, "console.log('pnpm');\n", "utf8");

    try {
      const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
        nodeExecPath: "/test-node",
        npmExecPath: pnpmExecPath,
        spawnCommand(command: string, args: string[], options: unknown) {
          calls.push({ args, command, options });
          const child = new FakeKnipProcess();
          queueMicrotask(() => {
            child.stdout.emit("data", "partial stdout");
            child.stderr.emit("data", "partial stderr");
            finishFakeProcess(child, 0, null);
          });
          return child;
        },
        writeStatus: () => {},
      });

      const result = await resultPromise;

      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        args: [
          pnpmExecPath,
          "dlx",
          "--package",
          "knip@6.32.2",
          "knip",
          "--config",
          "config/knip.config.ts",
          "--production",
          "--no-progress",
          "--reporter",
          "compact",
          "--files",
          "--no-config-hints",
        ],
        command: "/test-node",
        options: {
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      });
      expect(result).toStrictEqual({
        errorCode: undefined,
        errorMessage: undefined,
        output: "partial stdoutpartial stderr",
        signal: null,
        status: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("emits heartbeat status and reports Knip timeouts", async () => {
    const statuses: string[] = [];
    const child = new FakeKnipProcess();
    await withFakeProcessSignals(child, async (kills) => {
      const result = await runKnip(KNIP_UNUSED_FILE_ARGS, {
        heartbeatMs: 1,
        killGraceMs: FAKE_KNIP_KILL_GRACE_MS,
        maxBufferBytes: KNIP_MAX_BUFFER_BYTES,
        scanName: KNIP_UNUSED_FILE_SCAN_NAME,
        spawnCommand: () => child,
        timeoutMs: 5,
        writeStatus: (message: string) => statuses.push(message),
      });

      expect(statuses.some((message) => message.includes("still running"))).toBe(true);
      expect(statuses.some((message) => message.includes("timed out"))).toBe(true);
      expect(kills).toEqual(["SIGTERM"]);
      expect(result).toStrictEqual({
        errorCode: "ETIMEDOUT",
        errorMessage: expect.stringContaining("Knip production unused-file scan timed out"),
        output: "",
        signal: "SIGTERM",
        status: null,
      });
    });
  });

  it.skipIf(process.platform === "win32")(
    "waits for timed-out Knip process groups after the wrapper exits",
    async ({ signal }) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-timeout-"));
      const childPidPath = path.join(root, "child.pid");
      let childPid = 0;
      const ready = createDeferred<number>();
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
          "child.once('message', (pid) => { fs.writeFileSync(process.env.OPENCLAW_TEST_CHILD_PID, String(pid)); process.send(pid); });",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");

        let resultPromise!: ReturnType<typeof runKnip>;
        releaseAndWait = startProcessWatchdogFixture(() => {
          resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
            env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
            killGraceMs: 50,
            spawnCommand(_command, _args, options) {
              const parent = spawn(process.execPath, ["-e", parentScript], {
                ...options,
                stdio: ["ignore", "pipe", "pipe", "ipc"],
                env: { ...process.env, OPENCLAW_TEST_CHILD_PID: childPidPath },
              });
              parent.once("message", (message: unknown) => {
                if (typeof message === "number") {
                  ready.resolve(message);
                }
              });
              return parent;
            },
            timeoutMs: 100,
            writeStatus: () => {},
          });
          return resultPromise;
        });

        childPid = await withinTest(
          awaitGateBeforeSettlement(
            ready.promise,
            resultPromise,
            `timeout waiting for pid in ${childPidPath}`,
          ),
          signal,
        );
        expect(isProcessAlive(childPid)).toBe(true);

        await expect(withinTest(releaseAndWait(), signal)).resolves.toMatchObject({
          errorCode: "ETIMEDOUT",
        });
        // runKnip joins its timeout teardown before resolving the result.
        expect(isProcessAlive(childPid)).toBe(false);
      } finally {
        await releaseAndWait?.();
        if (!childPid && existsSync(childPidPath)) {
          childPid = Number(readFileSync(childPidPath, "utf8"));
        }
        killPidIfAlive(childPid || undefined);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "cleans active Knip descendants before forwarding parent SIGTERM",
    async ({ signal }) => {
      const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-knip-parent-signal-"));
      const childPidPath = path.join(root, "child.pid");
      const scriptUrl = pathToFileURL(path.resolve("scripts/deadcode-knip-runner.mts")).href;
      let childPid = 0;
      let runner: ReturnType<typeof spawn> | undefined;
      let closed: Promise<unknown[]> | undefined;

      try {
        const childScript = [
          "const fs = require('node:fs');",
          "process.on('SIGTERM', () => {});",
          `fs.writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));`,
          "process.send(process.pid);",
          "setInterval(() => {}, 1000);",
        ].join("");
        const parentScript = [
          "const { spawn } = require('node:child_process');",
          `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
          "child.once('message', (pid) => process.send(pid));",
          "process.on('SIGTERM', () => process.exit(0));",
          "setInterval(() => {}, 1000);",
        ].join("");
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
        closed = once(runner, "close");
        const ready = once(runner, "message");
        const [pid] = await withinTest(
          awaitGateBeforeSettlement(ready, closed, `timeout waiting for pid in ${childPidPath}`),
          signal,
        );
        childPid = Number(pid);
        expect(isProcessAlive(childPid)).toBe(true);

        runner.kill("SIGTERM");

        await expect(withinTest(closed, signal)).resolves.toEqual([null, "SIGTERM"]);
        await waitForDescendantExit(childPid, signal);
      } finally {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGTERM");
        }
        if (!childPid && existsSync(childPidPath)) {
          childPid = Number(readFileSync(childPidPath, "utf8"));
        }
        killPidIfAlive(childPid || undefined);
        await closed;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps output delivered after process exit but before stdio close", async () => {
    const child = new FakeKnipProcess();
    const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
      spawnCommand: () => child,
      writeStatus: () => {},
    });

    child.stdout.emit("data", "before-exit\n");
    child.emit("exit", 0, null);
    child.stdout.emit("data", "after-exit\n");
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: undefined,
      errorMessage: undefined,
      output: "before-exit\nafter-exit\n",
      signal: null,
      status: 0,
    });
  });

  it.each([1])("preserves split UTF-8 for interleaved Knip streams at byte %i", async (split) => {
    const child = new FakeKnipProcess();
    child.pid = 0;
    const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
      maxBufferBytes: 8,
      spawnCommand: () => child,
      writeStatus: () => {},
    });
    const stdout = Buffer.from("🦞");
    const stderr = Buffer.from("📦");
    child.stdout.emit("data", stdout.subarray(0, split));
    child.stderr.emit("data", stderr.subarray(0, split));
    child.stdout.emit("data", stdout.subarray(split));
    child.stderr.emit("data", stderr.subarray(split));
    finishFakeProcess(child, 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      errorCode: undefined,
      output: "🦞📦",
      signal: null,
      status: 0,
    });
  });

  it("does not flush a UTF-8 character cut by the Knip output byte cap", async () => {
    const child = new FakeKnipProcess();
    // This output-only child owns no OS process; the existing cap test covers signal delivery.
    child.pid = 0;
    const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
      maxBufferBytes: 4,
      spawnCommand: () => child,
      writeStatus: () => {},
    });
    const character = Buffer.from("🦞");
    child.stdout.emit("data", "ab");
    child.stdout.emit("data", character.subarray(0, 2));
    child.stdout.emit("data", character.subarray(2));
    finishFakeProcess(child, null, "SIGTERM");

    await expect(resultPromise).resolves.toMatchObject({
      errorCode: "ENOBUFS",
      output: "ab",
      signal: "SIGTERM",
      status: null,
    });
  });

  it("bounds captured Knip output", async () => {
    const child = new FakeKnipProcess();
    await withFakeProcessSignals(child, async (kills) => {
      const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
        killGraceMs: FAKE_KNIP_KILL_GRACE_MS,
        maxBufferBytes: 4,
        scanName: KNIP_UNUSED_FILE_SCAN_NAME,
        spawnCommand: () => child,
        timeoutMs: 1000,
        writeStatus: () => {},
      });
      child.stdout.emit("data", "too much output");

      await expect(resultPromise).resolves.toStrictEqual({
        errorCode: "ENOBUFS",
        errorMessage: "Knip production unused-file scan exceeded 4 output bytes",
        output: "too ",
        signal: "SIGTERM",
        status: null,
      });
      expect(kills).toEqual(["SIGTERM"]);
    });
  });

  it("reports spawn errors", async () => {
    const resultPromise = runKnip(KNIP_UNUSED_FILE_ARGS, {
      spawnCommand: () => {
        const child = new FakeKnipProcess();
        queueMicrotask(() =>
          child.emit(
            "error",
            Object.assign(new Error("spawn pnpm ENOENT"), {
              code: "ENOENT",
            }),
          ),
        );
        return child;
      },
      writeStatus: () => {},
    });

    await expect(resultPromise).resolves.toStrictEqual({
      errorCode: "ENOENT",
      errorMessage: "spawn pnpm ENOENT",
      output: "",
      signal: null,
      status: null,
    });
  });
});
