import type { ModelCostConfig } from "@openclaw/llm-core";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type { SessionCostUsageRollupRow } from "./session-cost-usage-cache.kernel.js";
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

export type UsageCostWorkerOperation =
  | { kind: "inventory"; minMtimeMs?: number; sessionFiles?: string[] }
  | ({ kind: "summary"; pricingFingerprint: string } & UsageCostWorkerRange)
  | {
      kind: "sessions";
      pricingFingerprint: string;
      sessions: Array<{
        sessionId?: string;
        sessionFile: string;
        transcriptFile?: UsageCostTranscriptFile;
      }>;
      startMs?: number;
      endMs?: number;
      includeUntimestamped?: boolean;
      reportBudgetBytes?: number;
      committedOnly?: boolean;
      dayBucket: UsageDailyBucket;
    }
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
      files: Array<
        Pick<UsageCostTranscriptFile, "kind" | "sourcePath" | "sessionId" | "mtimeMs"> & {
          transcriptFile?: UsageCostTranscriptFile;
        }
      >;
    }
  | { kind: "summary"; summary: CostUsageSummary; invalidRows: SessionCostUsageRollupRow[] }
  | {
      kind: "sessions";
      summaries: Array<SessionCostSummary | null>;
      cacheStatus: UsageCacheStatus;
      staleSessionFiles: string[];
      invalidRows: SessionCostUsageRollupRow[];
      remainingReportBytes?: number;
    }
  | { kind: "refresh"; changed: boolean; remainingFiles?: UsageCostPendingFile[] };

export type UsageCostWorkerFailure = {
  message: string;
  error?: OpenClawStateWorkerErrorPayload;
  hostOrigin?: number;
  hostFailureOnly?: boolean;
};

export class UsageCostHostEffectError extends Error {
  constructor(
    readonly origin: number,
    message: string,
  ) {
    super(message);
    this.name = "UsageCostHostEffectError";
  }
}

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
  restore: { input: SqliteSessionFileMarker; output: void };
  "prune-rows": { input: UsageCostPruneRow[]; output: void };
  prune: { input: Record<string, never>; output: void };
  write: { input: UsageCostPreparedRollup[]; output: boolean };
};

export type UsageCostWorkerHostRequest = {
  [Kind in keyof UsageCostWorkerHostEffects]: {
    kind: Kind;
    input: UsageCostWorkerHostEffects[Kind]["input"];
  };
}[keyof UsageCostWorkerHostEffects];

export type UsageCostWorkerHostReply =
  | { ok: true; value: UsageCostWorkerHostEffects[keyof UsageCostWorkerHostEffects]["output"] }
  | { ok: false; origin: number; message: string };
