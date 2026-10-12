// E2E Run With Pty tests cover e2e run with pty script behavior.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/e2e/lib/run-with-pty.mjs");
const posixIt = process.platform === "win32" ? it.skip : it;
const testNodeExecPath = resolveTestNodeExecPath();
const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

async function runPtyProbe(
  logPath: string,
  signal: AbortSignal,
  env: Record<string, string> = {},
  command: string[] = [
    "/bin/bash",
    "-lc",
    'printf "prompt\\n"; IFS= read -r value; printf "got:%s\\n" "$value"',
  ],
  input = "abc\n",
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(testNodeExecPath, [scriptPath, logPath, ...command], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = createBoundedChildOutput();
  const stderr = createBoundedChildOutput();
  const completion = waitForClose(child).then(({ code }) => ({
    code,
    stdout: stdout.text(),
    stderr: stderr.text(),
  }));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout.append(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr.append(chunk);
  });
  child.stdin.end(input);
  try {
    return await withinTest(completion, signal);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await completion;
  }
}

describe("run-with-pty", () => {
  it("rejects loose terminal dimension env values", ({ signal }) =>
    fixtureLifetime.run(async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
      const logPath = path.join(tempRoot, "pty.log");
      try {
        const result = await runPtyProbe(logPath, signal, { COLUMNS: "120cols" });

        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("invalid COLUMNS: 120cols");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }));

  it("forwards stdin through a PTY and writes the transcript log", ({ signal }) =>
    fixtureLifetime.run(async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
      const logPath = path.join(tempRoot, "pty.log");
      try {
        const result = await runPtyProbe(logPath, signal);
        const log = await readFile(logPath, "utf8");

        expect(result).toMatchObject({ code: 0, stderr: "" });
        expect(result.stdout).toContain("prompt");
        expect(result.stdout).toContain("got:abc");
        expect(log).toContain("prompt");
        expect(log).toContain("got:abc");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }));

  it("caps noisy PTY output in stdout and transcript logs", ({ signal }) =>
    fixtureLifetime.run(async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
      const logPath = path.join(tempRoot, "pty.log");
      try {
        const result = await runPtyProbe(
          logPath,
          signal,
          { OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES: "64" },
          [testNodeExecPath, "-e", "process.stdout.write('x'.repeat(2048))"],
          "",
        );
        const log = await readFile(logPath, "utf8");
        const marker = "[run-with-pty output truncated after 64 bytes]";

        expect(result).toMatchObject({ code: 0, stderr: "" });
        expect(result.stdout).toContain(marker);
        expect(log).toContain(marker);
        expect(result.stdout.length).toBeLessThan(512);
        expect(log.length).toBeLessThan(512);
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }));

  it("fails when the transcript log cannot be written", ({ signal }) =>
    fixtureLifetime.run(async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
      try {
        const result = await runPtyProbe(
          tempRoot,
          signal,
          {},
          [testNodeExecPath, "-e", "console.log('ready')"],
          "",
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("run-with-pty transcript log failed:");
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    }));

  posixIt(
    "escalates forwarded termination signals for PTY commands that ignore them",
    ({ signal }) =>
      fixtureLifetime.run(async () => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-run-with-pty-"));
        const logPath = path.join(tempRoot, "pty.log");
        const descendantPidPath = path.join(tempRoot, "descendant.pid");
        let descendantPid: number | null = null;
        const probeCode = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
process.on("SIGTERM", () => process.exit(0));
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.send(process.pid);setInterval(()=>{},1000);",
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
fs.writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
descendant.once("message", (pid) => console.log("ready:" + pid));
setInterval(() => {}, 1000);
`;
        const child = spawn(
          testNodeExecPath,
          [scriptPath, logPath, testNodeExecPath, "-e", probeCode],
          {
            env: {
              ...process.env,
              OPENCLAW_E2E_PTY_FORCE_KILL_MS: "25",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const stdout = createBoundedChildOutput();
        const stderr = createBoundedChildOutput();
        const ready = createDeferred<number>();
        const completion = waitForClose(child);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout.append(chunk);
          const match = stdout.text().match(/ready:(\d+)(?:\r?\n)/u);
          if (match) {
            ready.resolve(Number(match[1]));
          }
        });
        child.stderr.on("data", (chunk) => {
          stderr.append(chunk);
        });

        try {
          descendantPid = await withinTest(
            awaitGateBeforeSettlement(ready.promise, completion, "timed out waiting for condition"),
            signal,
          );
          child.kill("SIGTERM");
          const result = await withinTest(completion, signal);
          const log = await readFile(logPath, "utf8");

          expect(result).toEqual({ code: 143, signal: null });
          expect(stderr.text()).toBe("");
          expect(log).toContain("ready");
          expect(isProcessAlive(descendantPid)).toBe(false);
        } finally {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
          }
          await completion;
          if (descendantPid && isProcessAlive(descendantPid)) {
            process.kill(descendantPid, "SIGKILL");
          }
          await rm(tempRoot, { recursive: true, force: true });
        }
      }),
  );
});

function waitForClose(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
