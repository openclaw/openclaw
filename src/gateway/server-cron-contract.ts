// Gateway cron contracts stay separate from the runtime so shared request
// types do not pull scheduler implementation dependencies into their graph.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJobScratchState, CronJobScratchWriteResult } from "../cron/scratch-contract.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob } from "../cron/types.js";
import type { DeferredHookWake } from "../cron/wake-contract.js";
import type { CronExitWatchers } from "./cron-exit-watchers.js";

export type GatewayCronServiceContract = CronServiceContract & {
  /** Borrow the current resident jobs without loading storage. */
  getLoadedJobs(): readonly CronJob[] | undefined;
  /** Selected opaque partition after a list/job read prepares the serving cron owner. */
  getStoreKey?(): string;
  /** Cancel exact current definitions under the serving scheduler's operation lock. */
  quiesceJobs(
    jobs: readonly { id: string; revision: string }[],
    commitGuard: (cancel: () => void) => void | Promise<void>,
  ): Promise<void>;
  /** Remove an owned declarative job family from obsolete SQLite store partitions. */
  removeStaleJobFamily(
    family: { declarationKey: string; name: string; ownerPluginTag: string },
    opts?: { commitGuard?: () => void },
  ): Promise<number>;
  /** True once an accepted manual run wrote its terminal history row; false on timeout or abort. */
  waitForManualRun(runId: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean>;
  readScratch(
    id: string,
    options?: { assertCurrent?: () => void; signal?: AbortSignal },
  ): Promise<CronJobScratchState>;
  writeScratch(
    id: string,
    params: {
      content: string | null;
      expectedRevision?: number;
      sourceSha256?: string;
      commitGuard?: () => void;
    },
  ): Promise<CronJobScratchWriteResult>;
  /** Serialize agent-job removal with the roster commit and restore on failure. */
  removeAgentJobsTransactional<T>(agentId: string, commit: () => Promise<T>): Promise<T>;
  /** Temporarily disarm ticks without running startup recovery on resume. */
  pauseScheduling(): void;
  resumeScheduling(): void;
  /** Scheduler-owned work not represented by active cron run markers. */
  getSuspensionBlockerCount?(): number;
  /** Materialize lazy cron dependencies before a synchronous operator wake. */
  prepareWake?(): Promise<void>;
  /** Stop cron and await scheduler-owned child process teardown. */
  stopAndDrain?(): Promise<void>;
};

export type GatewayCronState = {
  cron: GatewayCronServiceContract;
  deferHookWake?: DeferredHookWake;
  storePath: string;
  cronEnabled: boolean;
  readHeartbeatSummary?: (cfg: OpenClawConfig) => Promise<CronJob[]>;
  prepareExitWatcherHandoff?: () => Promise<GatewayCronExitWatcherHandoff | undefined>;
  reconcileExitWatchers: () => Promise<void>;
  reconcileStreamWatchers: () => Promise<void>;
  stopStreamWatchers: () => Promise<void>;
};

export type GatewayCronExitWatcherHandoff = {
  current: () => CronExitWatchers;
  adopt: (watchers: CronExitWatchers) => Promise<void> | void;
  stopOwner: () => Promise<void>;
};
