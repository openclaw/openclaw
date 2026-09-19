// The no-output watchdog must remove the whole CLI process tree, not just the
// wrapped root: a surviving `claude -p` child would keep answering the session.
// A leaked descendant that still holds the inherited pipes must also deliver
// nothing after settlement.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForDead } from "../../../test/helpers/process-wait.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { killPidIfAlive, waitForPidFile } from "../../test-utils/process-tree.js";
import { createProcessSupervisor } from "./supervisor.js";

const WATCHDOG_TEST_TIMEOUT_MS = 60_000;
const LATE_OUTPUT_OBSERVATION_MS = 400;
const NO_OUTPUT_TIMEOUT_MS = 1_500;

const activePids = new Set<number>();
const tempDirs = createTempDirTracker();

afterEach(async () => {
  for (const pid of activePids) {
    killPidIfAlive(pid);
  }
  await Promise.all([...activePids].map((pid) => waitForDead(pid, 5_000).catch(() => {})));
  activePids.clear();
  tempDirs.cleanup();
});

async function createFakeCli() {
  const cwd = tempDirs.make("openclaw-watchdog-tree-");
  const cliPath = path.join(cwd, "fake-cli.cjs");
  const pidPath = path.join(cwd, "cli.pid");
  const descendantPidPath = path.join(cwd, "descendant.pid");
  await writeFile(
    cliPath,
    `
      const { spawn } = require("node:child_process");
      const { writeFileSync } = require("node:fs");
      writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      // The shipped CLI shape: a subprocess descendant of the root keeps the
      // conversation alive after the wrapper is signalled, so the watchdog must
      // remove it through the tree walk, not only the root.
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: "ignore",
      });
      writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
      process.stdout.write("fake-cli-start\\n");
      // Silent afterwards: this is what arms the no-output watchdog.
      setInterval(() => {}, 1_000);
    `,
    "utf8",
  );
  return { cwd, cliPath, pidPath, descendantPidPath };
}

describe("supervisor no-output watchdog process tree", () => {
  it(
    "terminates the CLI descendant tree and delivers nothing after settlement",
    async () => {
      const { cwd, cliPath, pidPath, descendantPidPath } = await createFakeCli();
      const delivered: string[] = [];
      const supervisor = createProcessSupervisor();
      const run = await supervisor.spawn({
        mode: "child",
        runId: "watchdog-tree",
        argv: [process.execPath, cliPath],
        cwd,
        noOutputTimeoutMs: NO_OUTPUT_TIMEOUT_MS,
        timeoutMs: 30_000,
        captureOutput: false,
        onStdout: (chunk: string) => delivered.push(chunk.trim()),
        onStderr: (chunk: string) => delivered.push(chunk.trim()),
      });
      if (run.pid !== undefined) {
        activePids.add(run.pid);
      }
      const descendantPid = await waitForPidFile(descendantPidPath, 15_000);
      activePids.add(descendantPid);
      expect(await waitForPidFile(pidPath, 15_000)).toBe(run.pid);

      const exit = await run.wait();
      const settledDelivered = [...delivered];
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LATE_OUTPUT_OBSERVATION_MS);
      });

      expect(exit.reason).toBe("no-output-timeout");
      expect(exit.noOutputTimedOut).toBe(true);
      await waitForDead(descendantPid, 10_000);
      if (run.pid !== undefined) {
        await waitForDead(run.pid, 10_000);
      }
      expect(delivered).toEqual(settledDelivered);
      expect(delivered).toContain("fake-cli-start");
      await supervisor.shutdown();
    },
    WATCHDOG_TEST_TIMEOUT_MS,
  );
});
