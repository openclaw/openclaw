import { resolveStorePath } from "../../config/sessions/paths.js";
import {
  listSessionTranscriptInstances,
  type SessionTranscriptInstance,
} from "../../config/sessions/session-accessor.js";
import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../routing/session-key.js";
import type {
  SkillHistoryScanCursor,
  SkillHistoryScanDirection,
  SkillHistoryScanScope,
} from "./history-scan-state.js";

const HISTORY_SCAN_BLOCKED_SEGMENTS = new Set([
  "active-memory",
  "commitments",
  "heartbeat",
  "hook",
  "memory",
  "skill-workshop-history-scan",
  "skill-workshop-review",
]);

export type SkillHistoryScanCandidate = {
  entry: SessionTranscriptInstance["entry"];
  instanceId: string;
  sessionKey: string;
  updatedAtMs: number;
};

export function isSkillHistoryScanSessionEligible(
  summary: Pick<SessionTranscriptInstance, "acpOwned" | "entry" | "provenanceKnown" | "sessionKey">,
): boolean {
  const { acpOwned, entry, provenanceKnown, sessionKey } = summary;
  if (
    !provenanceKnown ||
    acpOwned ||
    !sessionKey.trim() ||
    !entry.sessionId?.trim() ||
    entry.spawnedBy ||
    (entry.spawnDepth ?? 0) > 0 ||
    entry.pluginOwnerId ||
    entry.hookExternalContentSource ||
    isCronSessionKey(sessionKey) ||
    isSubagentSessionKey(sessionKey) ||
    isAcpSessionKey(sessionKey)
  ) {
    return false;
  }
  const segments = sessionKey.toLowerCase().split(":");
  return !segments.some((segment) => HISTORY_SCAN_BLOCKED_SEGMENTS.has(segment));
}

export function compareSkillHistoryScanCandidates(
  left: Pick<SkillHistoryScanCandidate, "instanceId" | "updatedAtMs">,
  right: Pick<SkillHistoryScanCandidate, "instanceId" | "updatedAtMs">,
): number {
  const timestampOrder = right.updatedAtMs - left.updatedAtMs;
  if (timestampOrder !== 0) {
    return timestampOrder;
  }
  return left.instanceId < right.instanceId ? -1 : left.instanceId > right.instanceId ? 1 : 0;
}

export function candidateOlderThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) > 0;
}

function candidateNewerThanCursor(
  candidate: SkillHistoryScanCandidate,
  cursor: SkillHistoryScanCursor,
): boolean {
  return compareSkillHistoryScanCandidates(candidate, cursor) < 0;
}

export function selectSkillHistoryScanCandidates(params: {
  candidates: readonly SkillHistoryScanCandidate[];
  direction: SkillHistoryScanDirection;
  oldestCursor?: SkillHistoryScanCursor;
  newestCursor?: SkillHistoryScanCursor;
}): SkillHistoryScanCandidate[] {
  if (params.direction === "newer") {
    return params.newestCursor
      ? params.candidates
          .filter((candidate) => candidateNewerThanCursor(candidate, params.newestCursor!))
          .toReversed()
      : [...params.candidates].toReversed();
  }
  return params.oldestCursor
    ? params.candidates.filter((candidate) =>
        candidateOlderThanCursor(candidate, params.oldestCursor!),
      )
    : [...params.candidates];
}

export function listHistoryScanCandidates(
  params: SkillHistoryScanScope,
): SkillHistoryScanCandidate[] {
  const storePath = resolveStorePath(params.config.session?.store, {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
  });
  return listSessionTranscriptInstances({
    agentId: params.agentId,
    storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
    ...(params.env ? { env: params.env } : {}),
  })
    .filter(isSkillHistoryScanSessionEligible)
    .map(({ entry, sessionId, sessionKey, updatedAtMs }) => ({
      entry,
      instanceId: sessionId,
      sessionKey,
      updatedAtMs,
    }))
    .toSorted(compareSkillHistoryScanCandidates);
}
