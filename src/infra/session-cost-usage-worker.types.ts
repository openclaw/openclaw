import type { ModelCostConfig } from "@openclaw/llm-core";
import type { SqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import type { SessionTranscriptStats } from "../config/sessions/session-accessor.sqlite-contract.js";
import type { MemoryTranscriptProjectionFrame } from "../config/sessions/session-transcript-reconcile-memory.js";
import type { OpenClawStateWorkerErrorPayload } from "../state/openclaw-state-worker-error.js";
import type {
  SessionCostUsageRollupByteRow,
  SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  UsageCacheStatus,
  UsageCostTranscriptFile,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

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
      sessions: Array<{ sessionId?: string; sessionFile: string }>;
      startMs?: number;
      endMs?: number;
      includeUntimestamped?: boolean;
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
  operation: UsageCostWorkerOperation;
};

export type UsageCostWorkerResult =
  | {
      kind: "inventory";
      files: Array<Pick<UsageCostTranscriptFile, "kind" | "sourcePath" | "sessionId" | "mtimeMs">>;
    }
  | { kind: "summary"; summary: CostUsageSummary; invalidRows: SessionCostUsageRollupRow[] }
  | {
      kind: "sessions";
      summaries: Array<SessionCostSummary | null>;
      cacheStatus: UsageCacheStatus;
      staleSessionFiles: string[];
      invalidRows: SessionCostUsageRollupRow[];
    }
  | { kind: "refresh" };

export type UsageCostWorkerFailure = {
  message: string;
  error?: OpenClawStateWorkerErrorPayload;
  hostOrigin?: number;
  hostFailureOnly?: boolean;
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
  previousValue: Uint8Array | null;
  value: Uint8Array;
  blob: Uint8Array;
  updatedAt: number;
};

type UsageCostPruneRow = {
  key: string;
  value: Uint8Array;
  updatedAt: number;
};

export type UsageCostWorkerHostEffects = {
  "refresh-session": { input: { sessionFile: string }; output: void };
  pricing: {
    input: Array<{ provider?: string; model?: string }>;
    output: Array<ModelCostConfig | undefined>;
  };
  restore: { input: SqliteSessionFileMarker; output: void };
  "memory-stats": {
    input: SqliteSessionFileMarker[];
    output: Array<SessionTranscriptStats | undefined>;
  };
  "memory-instances": {
    input: { agentId: string; storePath: string };
    output: Array<{ agentId: string; sessionId: string; updatedAtMs: number }>;
  };
  "memory-cache": {
    input: { filePaths?: readonly string[] };
    output: SessionCostUsageRollupByteRow[];
  };
  "memory-cache-body": {
    input: SessionCostUsageRollupRow;
    output: { blob: Uint8Array | null } | undefined;
  };
  "memory-transcript": {
    input: {
      marker: SqliteSessionFileMarker;
      afterSeq: number;
      throughSeq: number;
      readId: number;
    };
    output: MemoryTranscriptProjectionFrame;
  };
  "prune-row": { input: UsageCostPruneRow; output: void };
  prune: { input: Record<string, never>; output: void };
  write: { input: UsageCostPreparedRollup; output: boolean };
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
