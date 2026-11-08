import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, expect, it } from "vitest";
import { requireNodeTool, stripNodeTypeScriptTypes } from "../../test/helpers/node-toolchain.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterAll);
const read = (file: string) => fs.readFile(file, "utf8");
let directory: string;
beforeAll(async () => {
  directory = temp.make("openclaw-command-settlement-");
  const owner = stripNodeTypeScriptTypes(await read("src/process/exec-termination.ts")).replace(
    /from "(\.\.?\/[^"\n]+)"/g,
    'from "./dependencies.mjs"',
  );
  const retry = transformSync(await read("packages/retry/src/index.ts"), {
    loader: "ts",
    target: "esnext",
    format: "esm",
  }).code;
  await fs.writeFile(path.join(directory, "retry.mjs"), retry);
  // Keep the real timer owner so an unref regression still lets the child exit early.
  const sleep = stripNodeTypeScriptTypes(await read("src/utils/sleep.ts")).replace(
    /from "([^"\n]+)"/g,
    (_match, specifier: string) =>
      `from ${JSON.stringify(
        specifier === "../infra/abort-signal.js" || specifier === "@openclaw/retry"
          ? "./retry.mjs"
          : import.meta.resolve(specifier),
      )}`,
  );
  const modules = {
    "owner.mjs": owner,
    "dependencies.mjs": `
${sleep}
export const COMMAND_PROCESS_TREE_KILL_GRACE_MS = 300;
export const COMMAND_PROCESS_GROUP_EXIT_CONFIRMATION_MS = 10_000;
export const waitForCommandProcessGroupExit = () => { throw new Error('unexpected POSIX observation'); };
export const getWindowsSystem32ExePath = () => 'taskkill.exe';
export const getFileLockProcessStartTime = () => { throw new Error('unexpected POSIX identity'); };
export const isChildProcessTreeAlive = () => { throw new Error('unexpected POSIX group'); };
export const killProcessTree = () => { throw new Error('unexpected POSIX termination'); };
export const scheduleAdoptedChildZombieReapAfterExit = () => { throw new Error('unexpected POSIX reaping'); };
export const runOutsideCommandProcessScope = operation => operation();
let child, failure;
export let completedHelpers = 0;
export function bind(value, reject) { child = value; failure = reject; }
export async function spawnCommand() {
  // Simulate backend completion without retaining a native handle.
  await Promise.resolve();
  child.exitCode = 0;
  completedHelpers++;
  if (failure) throw new Error('fixture helper failure');
  return { exitCode: 0 };
}
`,
    "driver.mjs": `
import * as backend from './dependencies.mjs';
Object.defineProperty(process, 'platform', { value: 'win32' });
const { createCommandTerminationController } = await import('./owner.mjs');
const child = { pid: 4242, exitCode: null, signalCode: null };
backend.bind(child, JSON.parse(process.argv[2]));
const cancellation = new AbortController();
const owner = createCommandTerminationController({
  child, cancelController: cancellation, processTree: { mode: "graceful" },
  killGraceMs: 300, isChildExited: () => child.exitCode !== null,
  isCommandSettled: () => child.exitCode !== null,
});
owner.terminate();
const outcome = await owner.settle();
console.log(JSON.stringify({ outcome, completedHelpers: backend.completedHelpers,
  cancelled: cancellation.signal.aborted }));
`,
  };
  for (const [name, content] of Object.entries(modules)) {
    await fs.writeFile(path.join(directory, name), content);
  }
});

it.each([false, true])(
  "keeps Windows settlement alive after backend completion (failed helper: %s)",
  async (failedHelper) => {
    const result = await promisify(execFile)(
      requireNodeTool("node"),
      [path.join(directory, "driver.mjs"), JSON.stringify(failedHelper)],
      { env: { SystemRoot: process.env.SystemRoot, NODE_DISABLE_COMPILE_CACHE: "1" } },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      outcome: "forced",
      completedHelpers: 1,
      cancelled: false,
    });
  },
);
