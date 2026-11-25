import type { ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts/e2e/lib/run-with-pty.mjs");
const it = createCommandTest();
const posixIt = process.platform === "win32" ? it.skip : it;
const testNodeExecPath = resolveTestNodeExecPath();
const nodeCommand = (source: string) => [testNodeExecPath, "-e", source];
async function runPtyProbe(
  fixture: CommandFixture,
  logPath: string,
  env: Record<string, string> = {},
  command: string[] = [
    "/bin/bash",
    "-lc",
    'printf "prompt\\n"; IFS= read -r value; printf "got:%s\\n" "$value"',
  ],
  input = "abc\n",
) {
  return fixture.run(testNodeExecPath, [scriptPath, logPath, ...command], {
    env: { ...process.env, ...env },
    input,
  });
}

it("rejects loose terminal dimension env values", async ({ command }) => {
  const logPath = path.join(command.createTempDir("pty-"), "pty.log");
  const result = await runPtyProbe(command, logPath, { COLUMNS: "120cols" });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("invalid COLUMNS: 120cols");
});

it("forwards stdin through a PTY and writes the transcript log", async ({ command }) => {
  const logPath = path.join(command.createTempDir("pty-"), "pty.log");
  const result = await runPtyProbe(command, logPath);
  expect(result).toMatchObject({ status: 0, stderr: "", error: undefined });
  for (const output of [result.stdout, await readFile(logPath, "utf8")]) {
    expect(output).toContain("prompt");
    expect(output).toContain("got:abc");
  }
});

it("caps noisy PTY output in stdout and transcript logs", async ({ command }) => {
  const logPath = path.join(command.createTempDir("pty-"), "pty.log");
  const result = await runPtyProbe(
    command,
    logPath,
    { OPENCLAW_E2E_PTY_OUTPUT_MAX_BYTES: "64" },
    nodeCommand("process.stdout.write('x'.repeat(2048))"),
    "",
  );
  expect(result).toMatchObject({ status: 0, stderr: "", error: undefined });
  for (const output of [result.stdout, await readFile(logPath, "utf8")]) {
    expect(output).toContain("[run-with-pty output truncated after 64 bytes]");
    expect(output.length).toBeLessThan(512);
  }
});

it("fails when the transcript log cannot be written", async ({ command }) => {
  const tempRoot = command.createTempDir("pty-");
  const result = await runPtyProbe(command, tempRoot, {}, nodeCommand("console.log('ready')"), "");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("run-with-pty transcript log failed:");
});

posixIt("kills descendants ignoring forwarded PTY termination", async ({ signal, command }) => {
  const logPath = path.join(command.createTempDir("pty-"), "pty.log");
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
  const ready = createDeferred<number>();
  let child: ChildProcess | undefined;
  const completion = command.lifetime.track(
    runNodeScript(
      [scriptPath, logPath, ...nodeCommand(probeCode)],
      { ...process.env, OPENCLAW_E2E_PTY_FORCE_KILL_MS: "25" },
      undefined,
      {
        signal,
        onReady(process, output) {
          child = process;
          process.stdout!.on("data", () => {
            const match = output().stdout.match(/ready:(\d+)(?:\r?\n)/u);
            if (match) {
              ready.resolve(Number(match[1]));
            }
          });
        },
      },
    ),
  );
  try {
    descendantPid = await withinTest(
      awaitGateBeforeSettlement(ready.promise, completion, "timed out waiting for condition"),
      signal,
    );
    child!.kill("SIGTERM");
    const result = await withinTest(completion, signal);
    expect(result).toMatchObject({ status: 143, error: undefined, stderr: "" });
    expect(child!.signalCode).toBeNull();
    expect(await readFile(logPath, "utf8")).toContain("ready");
    expect(isProcessAlive(descendantPid)).toBe(false);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await completion;
    if (descendantPid && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
  }
});
