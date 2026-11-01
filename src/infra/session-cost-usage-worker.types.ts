import type { ModelCostConfig } from "@openclaw/llm-core";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
import type { UsageOverviewBatch } from "./session-cost-usage-overview-batch.js";
import type { UsageCostQuarterBackfillRow } from "./session-cost-usage-quarters.worker.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  UsageCacheStatus,
  UsageCostTranscriptFile,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";
import type { WorkerTaskOptions } from "./worker-task-pool.types.js";

export type SessionCostUsageWorkerOptions = Pick<
  WorkerTaskOptions<UsageCostWorkerInput>,
  "signal" | "onRequest" | "inputBytes" | "timeoutMs" | "transferList" | "onInputConsumed"
> & { beforeDispatch?: () => void };

export type SessionCostUsageWorkerScope = {
  assertCurrent: () => void;
  run: (
    input: UsageCostWorkerInput,
    options: SessionCostUsageWorkerOptions,
  ) => Promise<UsageCostWorkerResult>;
  /** Register before acquisition can wait; a failed cleanup stays owned for close retry. */
  retainCleanup: (close: () => Promise<void>) => () => void;
};

export type UsageCostWorkerDatabase = { agentId: string; path: string };

export type UsageCostWorkerLocation = {
  agentId: string;
  databasePath: string;
  storePath: string;
  env: NodeJS.ProcessEnv;
};

type UsageCostWorkerRange = {
  startMs: number;
  endMs: number;
  dayBucket: UsageDailyBucket;
};

export type UsageCostWorkerSession = {
  sessionId?: string;
  sessionFile: string;
};

/** A SQLite transcript as `[stores index, session id]`, so worker inputs name each store once. */
export type UsageCostOverviewInstance = UsageCostWorkerSession | [store: number, sessionId: string];

export type UsageCostWorkerOperation =
  | {
      kind: "inventory";
      minMtimeMs?: number;
      sessionFiles?: string[];
    }
  | ({ kind: "summary"; pricingFingerprint: string } & UsageCostWorkerRange)
  | {
      kind: "sessions";
      pricingFingerprint: string;
      sessions: Array<{
        sessionId?: string;
        sessionFile: string;
      }>;
      startMs?: number;
      endMs?: number;
      includeUntimestamped?: boolean;
      reportBudgetBytes?: number;
      dayBucket: UsageDailyBucket;
    }
  | ({
      kind: "overview";
      pricingFingerprint: string;
      /** Each family folds its instances into one row, in this order. */
      families: Array<UsageCostOverviewInstance[]>;
      stores: Array<{ agentId: string; storePath: string }>;
      includeUntimestamped?: boolean;
    } & UsageCostWorkerRange)
  | {
      kind: "refresh";
      pricingFingerprint: string;
      maxFiles?: number;
      sessionsDir?: string;
      sessionFiles?: string[];
      startMs?: number;
      rebuildRows?: SessionCostUsageRollupRow[];
    };

export type UsageCostWorkerInput = {
  kind: "usage-cost";
  location: UsageCostWorkerLocation;
  databases: UsageCostWorkerDatabase[];
  /** Logical selectors and their physical owners captured before acquiring custody. */
  stores: Array<{ agentId: string; storePath: string; database: UsageCostWorkerDatabase }>;
  /** Archive metadata discovery shares the roster captured before database custody. */
  archiveStorePaths: string[];
  operation: UsageCostWorkerOperation;
};

export type UsageCostPendingFile = { sessionFile: string; rollupId: string };

export type UsageCostWorkerResult =
  | {
      kind: "inventory";
      files: Array<Pick<UsageCostTranscriptFile, "kind" | "sourcePath" | "sessionId" | "mtimeMs">>;
    }
  | {
      kind: "summary";
      summary: CostUsageSummary;
      /** Sessions to refresh before the summary is current; private sessions report none. */
      staleSessionFiles: string[];
      invalidRows: SessionCostUsageRollupRow[];
    }
  | {
      kind: "sessions";
      summaries: Array<SessionCostSummary | null>;
      cacheStatus: UsageCacheStatus;
      staleSessionFiles: string[];
      invalidRows: SessionCostUsageRollupRow[];
      remainingReportBytes?: number;
    }
  | {
      kind: "overview";
      /** One packed row per requested family, in order. */
      batch: UsageOverviewBatch;
      /** Families with an instance whose usage is not summarized yet. */
      computing: boolean[];
      /** Instances whose quarter rows are not written yet (refresh or upgrade backfill). */
      summarizing: number;
      cacheStatus: UsageCacheStatus;
      staleSessionFiles: string[];
      invalidRows: SessionCostUsageRollupRow[];
    }
  | { kind: "refresh"; changed: boolean; remainingFiles?: UsageCostPendingFile[] };

export type UsageCostWorkerFailure = {
  message: string;
  error?: OpenClawStateWorkerErrorPayload;
};

/** Retain the domain failure while the pool proves native retirement. */
export class UsageCostWorkerReplyError extends Error {
  constructor(readonly failure: UsageCostWorkerFailure) {
    super(failure.message);
    this.name = "UsageCostWorkerReplyError";
  }
}

export type UsageCostWorkerReply =
  | { ok: true; value: UsageCostWorkerResult; closedDatabases: UsageCostWorkerDatabase[] }
  | { ok: false; error: UsageCostWorkerFailure };

type UsageCostPreparedRollup = {
  key: string;
  value: Uint8Array;
  blob: Uint8Array;
  updatedAt: number;
  partitions?: import("./session-cost-usage-partitions.js").UsageCostPartition[];
  removedDates?: string[];
  replacePartitions?: boolean;
};

type UsageCostPruneRow = {
  key: string;
  value: Uint8Array<ArrayBuffer>;
  updatedAt: number;
};

export type UsageCostWorkerHostEffects = {
  "refresh-session": { input: { sessionFile: string }; output: void };
  pricing: {
    input: Array<{ provider?: string; model?: string }>;
    output: Array<ModelCostConfig | undefined>;
  };
  "prune-rows": { input: UsageCostPruneRow[]; output: void };
  write: { input: UsageCostPreparedRollup[]; output: boolean };
  "write-quarters": { input: UsageCostQuarterBackfillRow[]; output: boolean };
};

export type UsageCostWorkerHostRequest = {
  [Kind in keyof UsageCostWorkerHostEffects]: {
    kind: Kind;
    input: UsageCostWorkerHostEffects[Kind]["input"];
  };
}[keyof UsageCostWorkerHostEffects];
