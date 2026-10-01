// A detached descendant can retain stdio after forced settlement. Callers
// finalize output hashes after wait(), so no later output may reach them.
import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../../test/helpers/process-wait.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ManagedRun } from "./types.js";

// SIGTERM plus the adapter's kill-wait fallback is a fixed ~9s production window.
const FORCED_SETTLEMENT_TEST_TIMEOUT_MS = 60_000;
const LATE_OUTPUT_OBSERVATION_MS = 500;

const activePids = new Set<number>();
const activePidFiles = new Set<string>();
const activeRuns = new Set<ManagedRun>();
const tempDirs = createTempDirTracker();
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

async function waitForFixtureExit(pid: number, signal: AbortSignal) {
  // The escaped pipe holder deliberately has no product-owned extinction promise.
  while (isProcessAlive(pid)) {
    await delay(10, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`Fixture process ${pid} did not exit`, { cause: error });
    });
  }
}

afterEach(async ({ signal }) => {
  try {
    for (const run of activeRuns) {
      run.cancel();
    }
    await Promise.allSettled([...activeRuns].map((run) => run.wait()));
    for (const pidFile of activePidFiles) {
      if (existsSync(pidFile)) {
        activePids.add(Number(readFileSync(pidFile, "utf8")));
      }
    }
    for (const pid of activePids) {
      killPidIfAlive(pid);
    }
    await Promise.all([...activePids].map((pid) => waitForFixtureExit(pid, signal)));
  } finally {
    activeRuns.clear();
    activePidFiles.clear();
    activePids.clear();
    tempDirs.cleanup();
  }
});

async function createLeakedPipeScope() {
  const cwd = tempDirs.make("openclaw-forced-settlement-");
  const leakPath = path.join(cwd, "leak.mjs");
  const leakPidPath = path.join(cwd, "leak.pid");
  const leakTickPath = path.join(cwd, "leak.ticks");
  const leakReadyPath = path.join(cwd, "leak.ready");
  const rootPath = path.join(cwd, "root.mjs");
  await writeFile(
    leakPath,
    `
      import { appendFileSync, writeFileSync } from "node:fs";
      ${fixtureReceiptClientSource(receipts.endpoint)}
      // Adapter disposal closes the parent-side pipes. Keep the escaped process
      // alive so its independent tick file proves output attempts continue.
      process.stdout.on("error", () => {});
      process.stderr.on("error", () => {});
      let tick = 0;
      setInterval(() => {
        tick += 1;
        appendFileSync(process.argv[3], ".");
        process.stdout.write("leaked-stdout-" + tick + "\\n");
        process.stderr.write("leaked-stderr-" + tick + "\\n");
      }, 50);
      writeFileSync(${JSON.stringify(leakReadyPath)}, "ready");
      sendReceipt(${JSON.stringify(leakReadyPath)}, "ready");
    `,
    "utf8",
  );
  await writeFile(
    rootPath,
    `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      process.stdout.write("live-stdout\\n");
      process.stderr.write("live-stderr\\n");
      // Inherit this root's stdout/stderr so the pipes outlive it, and detach so
      // the supervisor's process-group kill cannot reach the descendant. This is
      // the shipped CLI shape that would leave stdio open without terminal disposal.
      const leak = spawn(
        process.execPath,
        [${JSON.stringify(leakPath)}, ${JSON.stringify(leakPidPath)}, ${JSON.stringify(leakTickPath)}],
        { stdio: ["ignore", "inherit", "inherit"], detached: true },
      );
      // Retain identity before child boot, including when the test aborts during readiness.
      writeFileSync(${JSON.stringify(leakPidPath)}, String(leak.pid));
      leak.unref();
      setInterval(() => {}, 1_000);
    `,
    "utf8",
  );
  return { cwd, rootPath, leakPidPath, leakTickPath, leakReadyPath };
}

function readTickCount(tickPath: string): number {
  try {
    return statSync(tickPath).size;
  } catch {
    return 0;
  }
}

describe.skipIf(process.platform === "win32")("supervisor forced settlement output fence", () => {
  it(
    "delivers nothing after forced settlement with inherited pipes held by a descendant",
    async ({ signal }) => {
      const { cwd, rootPath, leakPidPath, leakTickPath, leakReadyPath } =
        await createLeakedPipeScope();
      activePidFiles.add(leakPidPath);
      const stdoutHash = crypto.createHash("sha256");
      const stderrHash = crypto.createHash("sha256");
      const delivered: string[] = [];
      // Production crashes uncaught inside the stream "data" handler; recording
      // the failure keeps the fence regression assertable instead of killing
      // the worker, and an empty list is the shipped contract.
      const hashFailures: string[] = [];
      const consume = (hash: crypto.Hash, label: string) => (chunk: string) => {
        delivered.push(`${label}:${chunk.trim()}`);
        try {
          hash.update(chunk);
        } catch (error) {
          hashFailures.push(`${label}:${(error as NodeJS.ErrnoException).code ?? String(error)}`);
        }
      };

      const supervisor = createProcessSupervisor();
      const run = await supervisor.spawn({
        mode: "child",
        argv: [process.execPath, rootPath],
        cwd,
        captureOutput: false,
        onStdout: consume(stdoutHash, "stdout"),
        onStderr: consume(stderrHash, "stderr"),
        onStdoutRaw: (raw) => delivered.push(`stdout-raw:${raw.toString("utf8").trim()}`),
        onStderrRaw: (raw) => delivered.push(`stderr-raw:${raw.toString("utf8").trim()}`),
      });
      activeRuns.add(run);
      if (run.pid !== undefined) {
        activePids.add(run.pid);
      }

      await withinTest(
        Promise.race([
          receipts.waitFor(leakReadyPath, "ready"),
          run.wait().then(
            () => {
              if (!existsSync(leakReadyPath)) {
                throw new Error(`timeout waiting for pid in ${leakPidPath}`);
              }
            },
            (error: unknown) => {
              if (!existsSync(leakReadyPath)) {
                throw error;
              }
            },
          ),
        ]),
        signal,
      );
      const leakedPid = Number(readFileSync(leakPidPath, "utf8"));
      activePidFiles.delete(leakPidPath);
      activePids.add(leakedPid);
      run.cancel("manual-cancel");

      const exit = await withinTest(run.wait(), signal);
      // Exactly what the CLI runner does with the terminal result it just read.
      const digests = [stdoutHash.digest("hex"), stderrHash.digest("hex")];
      const settledDelivered = [...delivered];
      const settledOutputAtMs = run.activity.lastOutputAtMs;
      const settledTicks = readTickCount(leakTickPath);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LATE_OUTPUT_OBSERVATION_MS);
      });

      expect(exit.reason).toBe("manual-cancel");
      expect(digests.every((digest) => digest.length === 64)).toBe(true);
      expect(settledDelivered).toContain("stdout:live-stdout");
      expect(settledDelivered).toContain("stderr-raw:live-stderr");
      // The descendant stayed alive and attempted output across the terminal
      // boundary even though adapter disposal closed the parent-side pipes.
      expect(readTickCount(leakTickPath)).toBeGreaterThan(settledTicks);
      expect(hashFailures).toEqual([]);
      expect(delivered).toEqual(settledDelivered);
      expect(run.activity.lastOutputAtMs).toBe(settledOutputAtMs);
      await expect(supervisor.shutdown()).rejects.toThrow("cleanup could not be confirmed");
    },
    FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
  );
});
