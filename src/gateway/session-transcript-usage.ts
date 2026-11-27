import path from "node:path";
import { resolveConcreteSessionStorePath } from "../config/sessions/paths.js";
import type { SessionTranscriptReadScope } from "../config/sessions/session-accessor.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { SessionTranscriptUsageSnapshot } from "./session-transcript-derived-readers.js";
import { readSessionTranscriptSummaryAsync } from "./session-transcript-readers.js";
import { readLatestSessionUsageFromTranscriptFileAsync } from "./session-utils.fs.js";

export { readRecentSessionUsageFromTranscriptAsync } from "./session-transcript-readers.js";

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
