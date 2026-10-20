import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { isProcessAlive, waitForDead } from "../../test/helpers/process-wait.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  createLeakedPipeScope,
  FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
} from "../process/supervisor/supervisor.forced-settlement.test-support.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import type { ManagedRun, ProcessSupervisor } from "../process/supervisor/types.js";
import { killPidIfAlive } from "../test-utils/process-tree.js";
import { createCronExitWatchers, type CronExitWatchers } from "./cron-exit-watchers.js";
import { onExitJob } from "./cron-exit-watchers.test-support.js";

const tempDirs = createTempDirTracker();
const activePids = new Set<number>();
const activePidFiles = new Set<string>();
const activeRuns = new Set<ManagedRun>();
const activeWatchers = new Set<CronExitWatchers>();
const activeSchedulers = new Set<GatewayScheduler>();
const activeSupervisors = new Set<ReturnType<typeof createProcessSupervisor>>();
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});

afterAll(async () => {
  await receipts.close();
});

afterEach(async ({ signal }) => {
  try {
    const closingWatchers = [...activeWatchers].map((watchers) => watchers.cancelAll());
    // A failed cleanup join is expected; observe it without turning it into success.
    const watcherSettlement = Promise.allSettled(closingWatchers);
    for (const run of activeRuns) {
      run.cancel("manual-cancel");
    }
    await Promise.allSettled([...activeRuns].map((run) => run.wait()));
    for (const pidFile of activePidFiles) {
      if (existsSync(pidFile)) {
        activePids.add(Number(readFileSync(pidFile, "utf8")));
      }
    }
    // Kill only identities retained by this fixture, including partial startup.
    for (const pid of activePids) {
      killPidIfAlive(pid);
    }
    await Promise.all([...activePids].map((pid) => waitForDead(pid, signal)));
    await withinTest(watcherSettlement, signal);
    await Promise.allSettled([...activeSupervisors].map((supervisor) => supervisor.shutdown()));
    await Promise.all([...activeSchedulers].map((scheduler) => scheduler.stop()));
  } finally {
    activePids.clear();
    activePidFiles.clear();
    activeRuns.clear();
    activeWatchers.clear();
    activeSchedulers.clear();
    activeSupervisors.clear();
    tempDirs.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.platform === "win32")("cron on-exit native cleanup", () => {
  // Linux's native subreaper retains descendants even after they change groups.
  it.skipIf(process.platform !== "linux" || Boolean(process.versions.bun))(
    "confirms physical extinction of an escaped descendant before retiring cancellation",
    async ({ signal }) => {
      const { cwd, rootPath, leakPidPath, leakReadyPath } = await createLeakedPipeScope(
        tempDirs.make("openclaw-cron-exit-cleanup-"),
        receipts.endpoint,
      );
      activePidFiles.add(leakPidPath);
      const nativeSupervisor = createProcessSupervisor();
      activeSupervisors.add(nativeSupervisor);
      const spawned = createDeferred<ManagedRun>();
      // Observe native admission without replacing its process or cleanup owner.
      const supervisor: ProcessSupervisor = {
        ...nativeSupervisor,
        spawn: async (input) => {
          const run = await nativeSupervisor.spawn(input);
          activeRuns.add(run);
          if (run.pid !== undefined) {
            activePids.add(run.pid);
          }
          spawned.resolve(run);
          return run;
        },
      };
      const scheduler = new GatewayScheduler();
      activeSchedulers.add(scheduler);
      const fireOnExit = vi.fn(async () => {});
      const watchers = createCronExitWatchers(
        {
          getProcessSupervisor: () => supervisor,
          fireOnExit,
          logger: { info: () => {}, warn: () => {} },
        },
        scheduler,
      );
      activeWatchers.add(watchers);
      const job = onExitJob(
        "native-cleanup-watch",
        `exec ${quoteCliArg(process.execPath)} ${quoteCliArg(rootPath)}`,
        true,
        cwd,
      );

      watchers.reconcile([job]);
      const run = await withinTest(spawned.promise, signal);
      await withinTest(
        awaitGateBeforeSettlement(
          receipts.waitFor(leakReadyPath, "ready"),
          run.wait(),
          "watched command settled before its escaped descendant was ready",
        ),
        signal,
      );
      const leakedPid = Number(readFileSync(leakPidPath, "utf8"));
      activePids.add(leakedPid);
      activePidFiles.delete(leakPidPath);
      expect(isProcessAlive(leakedPid)).toBe(true);
      expect(watchers.activeJobIds()).toEqual([job.id]);

      const cancellation = watchers.cancelAll();
      void cancellation.catch(() => {});
      const exit = await withinTest(run.wait(), signal);
      expect(exit.reason).toBe("manual-cancel");
      expect(run.waitForExtinction).toBeTypeOf("function");
      await withinTest(cancellation, signal);
      await expect(run.waitForExtinction!()).resolves.toBeUndefined();
      expect(isProcessAlive(leakedPid)).toBe(false);
      expect(fireOnExit).not.toHaveBeenCalled();
      expect(watchers.activeJobIds()).toEqual([]);
    },
    FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
  );
});
