import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requireNodeTool, stripNodeTypeScriptTypes } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterAll);
let directory: string;
beforeAll(async () => {
  directory = temp.make("openclaw-command-settlement-");
  const source = await fs.readFile(path.resolve("src/process/exec-termination.ts"), "utf8");
  const owner = stripNodeTypeScriptTypes(source).replace(
    /from "(\.\.?\/[^"\n]+)"/g,
    'from "./dependencies.mjs"',
  );
  await fs.writeFile(path.join(directory, "owner.mjs"), owner);
  await fs.writeFile(
    path.join(directory, "dependencies.mjs"),
    `
export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;
export const getWindowsSystem32ExePath = () => 'taskkill.exe';
export const getFileLockProcessStartTime = () => { throw new Error('unexpected POSIX identity'); };
export const isChildProcessTreeAlive = () => { throw new Error('unexpected POSIX group'); };
export const killProcessTree = () => { throw new Error('unexpected POSIX termination'); };
export const runOutsideCommandProcessScope = operation => operation();
let child, failure;
export let completedHelpers = 0;
export const requests = [];
export function bind(value, reject) { child = value; failure = reject; }
export async function spawnCommand(args) {
  requests.push(args);
  // Child exit and helper completion are inputs from the process backend.
  // Their completion leaves no referenced native handle in this fresh Node process.
  await Promise.resolve();
  child.exitCode = 0;
  completedHelpers++;
  if (failure) throw new Error('fixture helper failure');
  return { exitCode: 0 };
}
`,
  );
  await fs.writeFile(
    path.join(directory, "driver.mjs"),
    `
import * as backend from './dependencies.mjs';
Object.defineProperty(process, 'platform', { value: 'win32' });
const { createCommandTerminationController } = await import('./owner.mjs');
const scenario = JSON.parse(process.argv[2]);
const child = { pid: 4242, exitCode: null, signalCode: null };
backend.bind(child, scenario.failedHelper);
const cancellation = new AbortController();
const owner = createCommandTerminationController({
  child, cancelController: cancellation, processTree: { mode: scenario.mode },
  killGraceMs: 300, isChildExited: () => child.exitCode !== null,
  isCommandSettled: () => child.exitCode !== null,
});
owner.terminate();
const outcome = await owner.settle();
console.log(JSON.stringify({ outcome, completedHelpers: backend.completedHelpers,
  requests: backend.requests, cancelled: cancellation.signal.aborted }));
`,
  );
});

it.each([
  { mode: "graceful", failedHelper: false },
  { mode: "graceful", failedHelper: true },
  { mode: "force", failedHelper: false },
])(
  "keeps Windows $mode settlement alive after backend completion (failed helper: $failedHelper)",
  async (scenario) => {
    const result = await promisify(execFile)(
      requireNodeTool("node"),
      [path.join(directory, "driver.mjs"), JSON.stringify(scenario)],
      { env: { SystemRoot: process.env.SystemRoot, NODE_DISABLE_COMPILE_CACHE: "1" } },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "forced",
      completedHelpers: 1,
      requests: [
        ["taskkill.exe", "/PID", "4242", "/T", ...(scenario.mode === "force" ? ["/F"] : [])],
      ],
      cancelled: false,
    });
    expect(result.stderr).not.toContain("unsettled top-level await");
  },
);
