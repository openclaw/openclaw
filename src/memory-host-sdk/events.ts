import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "../infra/fs-safe.js";
import type { MemoryDreamingPhaseName } from "./dreaming.js";

export const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");

export type MemoryHostRecallRecordedEvent = {
  type: "memory.recall.recorded";
  timestamp: string;
  query: string;
  resultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
};

export type MemoryHostPromotionAppliedEvent = {
  type: "memory.promotion.applied";
  timestamp: string;
  memoryPath: string;
  applied: number;
  candidates: Array<{
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    recallCount: number;
  }>;
};

export type MemoryHostDreamCompletedEvent = {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};

export type MemoryCuratorDecisionEvent = {
  type:
    | "memory.curator.decision.allow"
    | "memory.curator.decision.deny"
    | "memory.curator.decision.approval_required";
  timestamp: string;
  agentId?: string;
  operation: "daily_flush" | "durable_promotion" | "dreaming_deep" | "cli_promote_apply";
  decision: "allow" | "deny" | "approval_required";
  targetRelativePath: string;
  sourcePath?: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  evidenceStatus: "Confirmed" | "Inferred" | "Unknown";
  confidence: "high" | "medium" | "low" | "Unknown";
  freshness: "current" | "recent" | "stale" | "Unknown";
  sensitivityClass: "public" | "internal" | "private" | "secret" | "Unknown";
  privateOrSharedScope: "private" | "shared" | "global" | "Unknown";
  reasons: string[];
  redactedPreview: string;
  score?: number;
  recallCount?: number;
  uniqueQueries?: number;
};

export type MemoryCuratorSignalEvent = {
  type:
    | "memory.curator.redacted"
    | "memory.curator.private_memory_blocked"
    | "memory.curator.stale_recall"
    | "memory.curator.contradiction_detected";
  timestamp: string;
  agentId?: string;
  operation: "daily_flush" | "durable_promotion" | "dreaming_deep" | "cli_promote_apply";
  targetRelativePath: string;
  sourcePath?: string;
  reasons: string[];
  redactedPreview?: string;
};

export type MemoryCuratorApprovalEvent = {
  type:
    | "memory.curator.approval.requested"
    | "memory.curator.approval.allowed_once"
    | "memory.curator.approval.denied"
    | "memory.curator.approval.expired"
    | "memory.curator.approval.replay_blocked";
  timestamp: string;
  agentId?: string;
  operation: "durable_promotion" | "dreaming_deep" | "cli_promote_apply";
  approvalId?: string;
  approvalToolCallId?: string;
  candidateCount: number;
  sensitivityClasses: string[];
  reasons: string[];
};

export type MemoryHostEvent =
  | MemoryHostRecallRecordedEvent
  | MemoryHostPromotionAppliedEvent
  | MemoryHostDreamCompletedEvent
  | MemoryCuratorDecisionEvent
  | MemoryCuratorSignalEvent
  | MemoryCuratorApprovalEvent;

export function resolveMemoryHostEventLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}

export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEvent,
): Promise<void> {
  const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  await appendRegularFile({
    filePath: eventLogPath,
    content: `${JSON.stringify(event)}\n`,
    rejectSymlinkParents: true,
  });
}

export async function readMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
}): Promise<MemoryHostEvent[]> {
  const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir);
  const raw = await fs.readFile(eventLogPath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  if (!raw.trim()) {
    return [];
  }
  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as MemoryHostEvent];
      } catch {
        return [];
      }
    });
  if (!Number.isFinite(params.limit)) {
    return events;
  }
  const limit = Math.max(0, Math.floor(params.limit as number));
  return limit === 0 ? [] : events.slice(-limit);
}
