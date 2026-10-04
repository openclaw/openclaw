import type { UsageCostWorkerHostEffects } from "../../infra/session-cost-usage-worker.types.js";
import type { SqliteWorkerCommand } from "../../infra/sqlite-worker-contract.js";
import type { RegisteredAgentWorkerOperations } from "../../state/openclaw-agent-execution-operations.js";
import type { IncognitoHistoryTarget } from "./session-incognito-history-contract.js";
import type { TranscriptProjectionPublicationOperations } from "./session-transcript-projection-publication.worker.js";
import type { MemoryTranscriptProjectionFrame } from "./session-transcript-reconcile-memory.js";

export type IncognitoUsageCacheOperations = Pick<
  RegisteredAgentWorkerOperations,
  Extract<keyof RegisteredAgentWorkerOperations, `usageCache.${string}`>
>;
type ProjectionOperations = Pick<
  TranscriptProjectionPublicationOperations,
  "claim" | "deleteChunk" | "appendChunk" | "finalize"
>;
export type IncognitoComputeTarget = Omit<IncognitoHistoryTarget, "admission">;
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
export type IncognitoComputeOperations = {
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
  [Key in keyof ProjectionOperations as `session.compute.projection.${Key}`]: {
    input: IncognitoComputeTarget & {
      sourceId: string;
      request: ProjectionOperations[Key]["input"];
    };
    output: ProjectionOperations[Key]["output"];
  };
} & {
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
    type === "session.compute.usage.releaseLock"
  );
}
