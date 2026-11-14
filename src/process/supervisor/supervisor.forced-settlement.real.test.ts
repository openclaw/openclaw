// A detached descendant can retain stdio after forced settlement. Callers
// finalize output hashes after wait(), so no later output may reach them.
import crypto from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, onTestFinished } from "vitest";
import { openFixtureReceiptChannel } from "../../../test/helpers/fixture-receipts.js";
import { isProcessAlive } from "../../../test/helpers/process-wait.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { killPidIfAlive } from "../../test-utils/process-tree.js";
import { waitForFixtureReceipt } from "./supervisor.fixture-readiness.test-support.js";
import {
  createLeakedPipeScope,
  FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
} from "./supervisor.forced-settlement.test-support.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { ManagedRun } from "./types.js";

const LATE_OUTPUT_OBSERVATION_MS = 500;

async function waitForFixtureExit(pid: number, signal: AbortSignal) {
  // The escaped pipe holder deliberately has no product-owned extinction promise.
  while (isProcessAlive(pid)) {
    await delay(10, undefined, { signal }).catch((error: unknown) => {
      throw new Error(`Fixture process ${pid} did not exit`, { cause: error });
    });
  }
}

function readTickCount(tickPath: string): number {
  try {
    return statSync(tickPath).size;
  } catch {
    return 0;
  }
}

it.skipIf(process.platform === "win32")(
  "delivers nothing after forced settlement with inherited pipes held by a descendant",
  async ({ signal }) => {
    const tempDirs = createTempDirTracker();
    const receipts = await openFixtureReceiptChannel();
    const owned: { run?: ManagedRun; leakPidPath?: string } = {};
    onTestFinished(async ({ signal: cleanupSignal }) => {
      const { run, leakPidPath } = owned;
      try {
        run?.cancel();
        await run?.wait().catch(() => undefined);
        const pids = [
          run?.pid,
          leakPidPath && existsSync(leakPidPath)
            ? Number(readFileSync(leakPidPath, "utf8"))
            : undefined,
        ].filter((pid): pid is number => typeof pid === "number");
        pids.forEach(killPidIfAlive);
        await Promise.all(pids.map((pid) => waitForFixtureExit(pid, cleanupSignal)));
      } finally {
        await receipts.close().finally(tempDirs.cleanup);
      }
    });
    const fixture = await createLeakedPipeScope(
      tempDirs.make("openclaw-forced-settlement-"),
      receipts.endpoint,
    );
    const { cwd, rootPath, leakPidPath, leakTickPath, leakReadyPath } = fixture;
    owned.leakPidPath = leakPidPath;
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
    owned.run = run;
    await waitForFixtureReceipt(
      receipts,
      leakReadyPath,
      run.wait(),
      signal,
      `timeout waiting for pid in ${leakPidPath}`,
    );
    run.cancel("manual-cancel");

    const exit = await withinTest(run.wait(), signal);
    // Exactly what the CLI runner does with the terminal result it just read.
    const digests = [stdoutHash.digest("hex"), stderrHash.digest("hex")];
    const settledDelivered = [...delivered];
    const settledOutputAtMs = run.activity.lastOutputAtMs;
    const settledTicks = readTickCount(leakTickPath);
    await delay(LATE_OUTPUT_OBSERVATION_MS);

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
    // The terminal result must retain its own failed cleanup join for callers.
    await expect(run.waitForExtinction!()).rejects.toThrow("cleanup could not be confirmed");
    await expect(supervisor.shutdown()).rejects.toThrow("cleanup could not be confirmed");
  },
  FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
);
