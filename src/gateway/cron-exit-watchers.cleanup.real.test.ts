import { existsSync, readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
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
const activeRuns = new Set<ManagedRun>();
let activePidFile: string | undefined;
let watchers: CronExitWatchers | undefined;
let scheduler: GatewayScheduler | undefined;
let nativeSupervisor: ReturnType<typeof createProcessSupervisor> | undefined;
let receipts: FixtureReceiptChannel;

beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});

afterAll(async () => {
  await receipts.close();
});

afterEach(async ({ signal }) => {
  try {
    // A failed cleanup join is expected; observe it without turning it into success.
    const watcherSettlement = Promise.allSettled([watchers?.cancelAll()]);
    for (const run of activeRuns) {
      run.cancel("manual-cancel");
    }
    await Promise.allSettled([...activeRuns].map((run) => run.wait()));
    if (activePidFile && existsSync(activePidFile)) {
      activePids.add(Number(readFileSync(activePidFile, "utf8")));
    }
    // Kill only identities retained by this fixture, including partial startup.
    for (const pid of activePids) {
      killPidIfAlive(pid);
    }
    await Promise.all([...activePids].map((pid) => waitForDead(pid, signal)));
    await withinTest(watcherSettlement, signal);
    await Promise.allSettled([nativeSupervisor?.shutdown()]);
    await scheduler?.stop();
  } finally {
    activePids.clear();
    activeRuns.clear();
    activePidFile = watchers = scheduler = nativeSupervisor = undefined;
    tempDirs.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

// Linux's native subreaper retains descendants even after they change groups.
it.skipIf(process.platform !== "linux" || Boolean(process.versions.bun))(
  "confirms physical extinction of an escaped descendant before retiring cancellation",
  async ({ signal }) => {
    const { cwd, rootPath, leakPidPath, leakReadyPath } = await createLeakedPipeScope(
      tempDirs.make("openclaw-cron-exit-cleanup-"),
      receipts.endpoint,
    );
    activePidFile = leakPidPath;
    const native = (nativeSupervisor = createProcessSupervisor());
    const spawned = createDeferred<ManagedRun>();
    // Observe native admission without replacing its process or cleanup owner.
    const supervisor: ProcessSupervisor = {
      ...native,
      spawn: async (input) => {
        const run = await native.spawn(input);
        activeRuns.add(run);
        if (run.pid !== undefined) {
          activePids.add(run.pid);
        }
        spawned.resolve(run);
        return run;
      },
    };
    scheduler = new GatewayScheduler();
    const fireOnExit = vi.fn(async () => {});
    watchers = createCronExitWatchers(
      {
        getProcessSupervisor: () => supervisor,
        fireOnExit,
        logger: { info: () => {}, warn: () => {} },
      },
      scheduler,
    );
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
    activePidFile = undefined;
    expect(isProcessAlive(leakedPid)).toBe(true);
    expect(watchers.activeJobIds()).toEqual([job.id]);

    const cancellation = watchers.cancelAll();
    void cancellation.catch(() => {});
    const exit = await withinTest(run.wait(), signal);
    expect(exit.reason).toBe("manual-cancel");
    await withinTest(cancellation, signal);
    await expect(run.waitForExtinction!()).resolves.toBeUndefined();
    expect(isProcessAlive(leakedPid)).toBe(false);
    expect(fireOnExit).not.toHaveBeenCalled();
    expect(watchers.activeJobIds()).toEqual([]);
  },
  FORCED_SETTLEMENT_TEST_TIMEOUT_MS,
);
