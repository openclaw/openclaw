import path from "node:path";
import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  aggregateSessionTranscriptUsage,
  type SessionTranscriptUsageSnapshot,
} from "./session-transcript-derived-readers.js";
import {
  readRecentSessionMessagesWithStatsAsync,
  readSessionTranscriptSummaryAsync,
} from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptFileAsync } from "./session-utils.fs.js";

/** Reads aggregate usage from a full transcript asynchronously through the reader seam. */
export async function readLatestSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const artifactFile = scope.sessionFile?.trim();
  const concreteStorePath = resolveConcreteSessionStorePath(scope.storePath);
  const targetAgentId = scope.agentId?.trim() || resolveAgentIdFromSessionKey(scope.sessionKey);
  const hasCompleteTarget = Boolean(targetAgentId && scope.sessionKey?.trim() && concreteStorePath);
  if (
    !hasCompleteTarget &&
    artifactFile &&
    path.isAbsolute(artifactFile) &&
    artifactFile.endsWith(".jsonl")
  ) {
    return await readLatestSessionUsageFromTranscriptFileAsync(
      scope.sessionId,
      concreteStorePath,
      artifactFile,
    );
  }
  const { usage } = await readSessionTranscriptSummaryAsync(scope, { kind: "usage" });
  return usage;
}

/** Reads bounded usage through the existing asynchronous history owner. */
export async function readRecentSessionUsageFromTranscriptAsync(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): Promise<SessionTranscriptUsageSnapshot | null> {
  const page = await readRecentSessionMessagesWithStatsAsync(scope, {
    maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
    maxLines: 1000,
    maxMessages: 1000,
    readOnly: true,
    allowResetArchiveFallback: false,
  });
  return aggregateSessionTranscriptUsage(page.messages);
}
