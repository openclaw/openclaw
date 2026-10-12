import type { UsageCostWorkerHostEffects } from "../../infra/session-cost-usage-worker.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { RegisteredAgentWorkerOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import type {
  TranscriptProjectionPublicationOperations,
  TranscriptProjectionRebuildOperations,
} from "./session-transcript-projection-publication.worker.js";
import type { MemoryTranscriptProjectionFrame } from "./session-transcript-reconcile-memory.js";

export type IncognitoUsageCacheOperations = Pick<
  RegisteredAgentWorkerOperations,
  Extract<keyof RegisteredAgentWorkerOperations, `usageCache.${string}`>
>;
export type IncognitoComputeTarget = Omit<IncognitoHistoryTarget, "admission"> & {
  /** Store inventory may select a retained window under its current session owner. */
  historical?: boolean;
};
export type IncognitoComputeInstance = IncognitoComputeTarget & { updatedAtMs: number };
type Reads = {
  stats: {
    input: Record<never, never>;
    output: UsageCostWorkerHostEffects["memory-stats"]["output"][number];
  };
  cache: {
    input: { filePaths: readonly string[] };
    output: UsageCostWorkerHostEffects["memory-cache"]["output"];
  };
  cacheBody: UsageCostWorkerHostEffects["memory-cache-body"];
  refreshLock: { input: Record<never, never>; output: string | null };
};

/** Every bounded extraction/publication gets its own actor FIFO turn. */
type SessionComputeOperations = {
  [Key in keyof Reads as `session.compute.usage.${Key}`]: {
    input: IncognitoComputeTarget & { request: Reads[Key]["input"] };
    output: Reads[Key]["output"];
  };
} & {
  [
    Key in keyof IncognitoUsageCacheOperations as Key extends `usageCache.${infer Name}`
      ? `session.compute.usage.${Name}`
      : never
  ]: {
    input: IncognitoComputeTarget & { request: IncognitoUsageCacheOperations[Key]["input"] };
    output: IncognitoUsageCacheOperations[Key]["output"];
  };
} & {
  [Key in keyof TranscriptProjectionRebuildOperations as `session.compute.projection.${Key}`]: {
    input: IncognitoComputeTarget & {
      sourceId: string;
      request: TranscriptProjectionRebuildOperations[Key]["input"];
    };
    output: TranscriptProjectionRebuildOperations[Key]["output"];
  };
} & {
  "session.compute.status": { input: IncognitoComputeTarget; output: boolean };
  "session.compute.source.open": {
    input: IncognitoComputeTarget & {
      sourceId: string;
      range?: { afterSeq: number; throughSeq: number };
    };
    output: void;
  };
  "session.compute.source.read": {
    input: IncognitoComputeTarget & { sourceId: string };
    output: MemoryTranscriptProjectionFrame;
  };
  "session.compute.source.release": {
    input: IncognitoComputeTarget & { sourceId: string };
    output: boolean;
  };
};

type StoreUsageOperations = Omit<Reads, "stats"> & {
  [
    Key in keyof IncognitoUsageCacheOperations as Key extends `usageCache.${infer Name}`
      ? Name
      : never
  ]: IncognitoUsageCacheOperations[Key];
};
export type IncognitoStoreComputeOperations = {
  [Key in keyof StoreUsageOperations as `session.compute.store.${Key}`]: {
    input: { request: StoreUsageOperations[Key]["input"] };
    output: StoreUsageOperations[Key]["output"];
  };
} & {
  "session.compute.store.status": { input: { sessionId: string }; output: boolean };
  "session.compute.store.inventory": {
    input: Record<never, never>;
    output: IncognitoComputeInstance[];
  };
  "session.compute.store.preflight": {
    input: Record<never, never>;
    output: TranscriptProjectionPublicationOperations["preflight"]["output"] & {
      targets: IncognitoComputeInstance[];
    };
  };
  "session.compute.store.sweep": {
    input: Record<never, never>;
    output: TranscriptProjectionPublicationOperations["sweep"]["output"];
  };
};
export type IncognitoComputeOperations = SessionComputeOperations & IncognitoStoreComputeOperations;

export function isIncognitoStoreComputeCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoStoreComputeOperations> {
  return command.type.startsWith("session.compute.store.");
}

export function isIncognitoComputeCommand(command: {
  type: string;
}): command is SqliteWorkerCommand<IncognitoComputeOperations> {
  return command.type.startsWith("session.compute.");
}

export function isIncognitoComputeWrite(type: keyof IncognitoComputeOperations): boolean {
  return (
    type.startsWith("session.compute.projection.") ||
    type === "session.compute.source.release" ||
    type === "session.compute.usage.writeRollup" ||
    type === "session.compute.usage.prune" ||
    type === "session.compute.usage.acquireLock" ||
    type === "session.compute.usage.releaseLock" ||
    type === "session.compute.store.preflight" ||
    type === "session.compute.store.sweep" ||
    type === "session.compute.store.writeRollup" ||
    type === "session.compute.store.prune" ||
    type === "session.compute.store.acquireLock" ||
    type === "session.compute.store.releaseLock"
  );
}
