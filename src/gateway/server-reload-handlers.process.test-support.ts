import { writeFile } from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { ManagedRun } from "../process/supervisor/types.js";
import { buildWindowsCmdExeCommandLine } from "../process/windows-command.js";

export const fixtureLifetime = createFixtureLifetime();

export async function createSupervisedExitWatcherFixture(fixtureDir: string) {
  const childScriptPath = path.join(fixtureDir, "watcher.cjs");
  const markerPath = path.join(fixtureDir, "watcher-runs.txt");
  const releasePath = path.join(fixtureDir, "release-watcher");
  await writeFile(
    childScriptPath,
    "const fs=require('node:fs');" +
      "fs.appendFileSync(process.argv[2],'run\\n');" +
      "process.stdout.write('watcher-ready\\n');" +
      "const timer=setInterval(()=>{if(fs.existsSync(process.argv[3]))clearInterval(timer)},10)",
    "utf8",
  );
  const childArgs = [childScriptPath, markerPath, releasePath];
  const command =
    process.platform === "win32"
      ? buildWindowsCmdExeCommandLine(process.execPath, childArgs)
      : [process.execPath, ...childArgs].map((argument) => JSON.stringify(argument)).join(" ");
  const supervisor = getProcessSupervisor();
  const childStarted = createDeferred();
  const spawning = createDeferred<ManagedRun>();
  // Reconciliation can handle a rejected spawn before the test joins its receipt.
  void spawning.promise.catch(() => {});
  const spawnChild = supervisor.spawn.bind(supervisor);
  let stdout = "";
  const spawn = vi.spyOn(supervisor, "spawn").mockImplementation((input) => {
    const run = spawnChild({
      ...input,
      onStdout: (chunk) => {
        input.onStdout?.(chunk);
        stdout += chunk;
        if (stdout.includes("watcher-ready\n")) {
          childStarted.resolve();
        }
      },
    });
    spawning.resolve(run);
    return run;
  });
  return {
    markerPath,
    releasePath,
    command,
    childStarted: childStarted.promise,
    spawning: spawning.promise,
    spawn,
  };
}

export function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}
