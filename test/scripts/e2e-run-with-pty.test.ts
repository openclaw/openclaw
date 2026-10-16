import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
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

function withPtyFixture(run: (root: string, logPath: string) => Promise<void>) {
  return fixtureLifetime.run(() => {
    const root = fixtureLifetime.createTempDir("openclaw-run-with-pty-");
    return run(root, path.join(root, "pty.log"));
  });
}

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
    withPtyFixture(async (_root, logPath) => {
      const result = await runPtyProbe(logPath, signal, { COLUMNS: "120cols" });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("invalid COLUMNS: 120cols");
    }));

  it("forwards stdin through a PTY and writes the transcript log", ({ signal }) =>
    withPtyFixture(async (_root, logPath) => {
      const result = await runPtyProbe(logPath, signal);
      const log = await readFile(logPath, "utf8");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      for (const output of [result.stdout, log]) {
        expect(output).toContain("prompt");
        expect(output).toContain("got:abc");
      }
    }));

  it("caps noisy PTY output in stdout and transcript logs", ({ signal }) =>
    withPtyFixture(async (_root, logPath) => {
      const result = await runPtyProbe(
        logPath,
        signal,
        { OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES: "64" },
        [testNodeExecPath, "-e", "process.stdout.write('x'.repeat(2048))"],
        "",
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      for (const output of [result.stdout, await readFile(logPath, "utf8")]) {
        expect(output).toContain("[run-with-pty output truncated after 64 bytes]");
        expect(output.length).toBeLessThan(512);
      }
    }));

  it("fails when the transcript log cannot be written", ({ signal }) =>
    withPtyFixture(async (tempRoot) => {
      const result = await runPtyProbe(
        tempRoot,
        signal,
        {},
        [testNodeExecPath, "-e", "console.log('ready')"],
        "",
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("run-with-pty transcript log failed:");
    }));

  posixIt(
    "escalates forwarded termination signals for PTY commands that ignore them",
    ({ signal }) =>
      withPtyFixture(async (tempRoot, logPath) => {
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
