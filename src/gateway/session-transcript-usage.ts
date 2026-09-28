import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import {
  readRecentSessionTranscriptMessageEvents,
  visitSessionTranscriptMessageEvents,
} from "../config/sessions/session-accessor.sqlite-active-events.js";
import { resolveSessionTranscriptReadTarget } from "../config/sessions/session-accessor.transcript-target.js";
import { readRestoredSessionTranscript } from "../config/sessions/session-cold-storage-read.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  aggregateSessionTranscriptUsage,
  createSessionTranscriptUsageAccumulator,
  type SessionTranscriptUsageSnapshot,
} from "./session-transcript-derived-readers.js";
import { toTranscriptReadScope } from "./session-transcript-read-target.js";
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
      undefined,
    );
  }
  const target = resolveSessionTranscriptReadTarget(scope);
  const transcriptScope = toTranscriptReadScope(target);
  return readRestoredSessionTranscript(transcriptScope, () => {
    const usage = createSessionTranscriptUsageAccumulator();
    visitSessionTranscriptMessageEvents(transcriptScope, (entry) => {
      usage.add(asOptionalRecord(entry.event)?.message);
    });
    return usage.finish();
  });
}

/** Reads aggregate usage from a bounded transcript tail synchronously through the reader seam. */
export function readRecentSessionUsageFromTranscript(
  scope: SessionTranscriptReadScope,
  maxBytes: number,
): SessionTranscriptUsageSnapshot | null {
  const target = resolveSessionTranscriptReadTarget(scope);
  const page = readRecentSessionTranscriptMessageEvents(toTranscriptReadScope(target), {
    maxBytes: Math.max(1024, Math.floor(Number.isFinite(maxBytes) ? maxBytes : 8 * 1024 * 1024)),
    maxLines: 1000,
    maxMessages: 1000,
  });
  return aggregateSessionTranscriptUsage(
    page.events.map((entry) => asOptionalRecord(entry.event)?.message),
  );
}
