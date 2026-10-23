import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/e2e/lib/run-with-pty.mjs");
const posixIt = process.platform === "win32" ? it.skip : it;
const testNodeExecPath = resolveTestNodeExecPath();
const nodeCommand = (source: string) => [testNodeExecPath, "-e", source];
const fixtureLifetime = createFixtureLifetime();
afterEach(() => fixtureLifetime.cleanup());

function withPtyFixture(run: (root: string, logPath: string) => Promise<void>) {
  return fixtureLifetime.run(() => {
    const root = fixtureLifetime.createTempDir("openclaw-run-with-pty-");
    return run(root, path.join(root, "pty.log"));
  });
}

function startPty(logPath: string, command: string[], env: Record<string, string>, input?: string) {
  const args = [scriptPath, logPath, ...command];
  const options = { env: { ...process.env, ...env } };
  const child =
    input === undefined
      ? spawn(testNodeExecPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(testNodeExecPath, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
  const stdout = createBoundedChildOutput();
  const stderr = createBoundedChildOutput();
  for (const [stream, output] of [
    [child.stdout, stdout],
    [child.stderr, stderr],
  ] as const) {
    stream.setEncoding("utf8");
    stream.on("data", output.append);
  }
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    },
  );
  child.stdin?.end(input);
  return { child, stdout, stderr, completion };
}

async function finishPty(child: ReturnType<typeof spawn>, completion: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  await completion;
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
) {
  const { child, stdout, stderr, completion } = startPty(logPath, command, env, input);
  try {
    const { code } = await withinTest(completion, signal);
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    await finishPty(child, completion);
  }
}

it("rejects loose terminal dimension env values", ({ signal }) =>
  withPtyFixture(async (_root, logPath) => {
    const result = await runPtyProbe(logPath, signal, { COLUMNS: "120cols" });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("invalid COLUMNS: 120cols");
  }));

it("forwards stdin through a PTY and writes the transcript log", ({ signal }) =>
  withPtyFixture(async (_root, logPath) => {
    const result = await runPtyProbe(logPath, signal);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const output of [result.stdout, await readFile(logPath, "utf8")]) {
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
      nodeCommand("process.stdout.write('x'.repeat(2048))"),
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
    const result = await runPtyProbe(tempRoot, signal, {}, nodeCommand("console.log('ready')"), "");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run-with-pty transcript log failed:");
  }));

posixIt("kills descendants ignoring forwarded PTY termination", ({ signal }) =>
  withPtyFixture(async (_root, logPath) => {
    let descendantPid: number | null = null;
    const probeCode = `
const { spawn } = require("node:child_process");
process.on("SIGTERM", () => process.exit(0));
const descendant = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});process.send(process.pid);setInterval(()=>{},1000);",
], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
descendant.once("message", (pid) => console.log("ready:" + pid));
setInterval(() => {}, 1000);
`;
    const { child, stdout, stderr, completion } = startPty(logPath, nodeCommand(probeCode), {
      OPENCLAW_E2E_PTY_FORCE_KILL_MS: "25",
    });
    const ready = createDeferred<number>();
    child.stdout.on("data", () => {
      const match = stdout.text().match(/ready:(\d+)(?:\r?\n)/u);
      if (match) {
        ready.resolve(Number(match[1]));
      }
    });
    try {
      descendantPid = await withinTest(
        awaitGateBeforeSettlement(ready.promise, completion, "timed out waiting for condition"),
        signal,
      );
      child.kill("SIGTERM");
      const result = await withinTest(completion, signal);
      expect({ ...result, stderr: stderr.text() }).toEqual({ code: 143, signal: null, stderr: "" });
      expect(await readFile(logPath, "utf8")).toContain("ready");
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      await finishPty(child, completion);
      if (descendantPid && isProcessAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  }),
);

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
