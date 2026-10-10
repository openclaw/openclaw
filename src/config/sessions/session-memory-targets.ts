import { normalizeAgentId } from "../../routing/session-key.js";
import type { SessionTranscriptInstance } from "./session-accessor.sqlite-contract.js";
import { listSessionTranscriptInstances } from "./session-accessor.sqlite-entry.js";
import { listSessionTranscriptArchivesReadOnly } from "./session-accessor.sqlite-history.js";
import { listSessionParticipantsReadOnly } from "./session-accessor.sqlite-participant-read.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import type {
  MemorySessionSelectors,
  MemorySessionTarget,
} from "./session-memory-targets.types.js";
import type { SessionParticipantIdentity } from "./session-participant-identity.js";

export function projectSessionMetadata(
  instance: SessionTranscriptInstance,
  participants: SessionParticipantIdentity[] = [],
): MemorySessionTarget {
  return {
    agentId: instance.agentId,
    sessionId: instance.sessionId,
    sessionKey: instance.sessionKey,
    resolution: "live",
    ...instance.sourceMetadata,
    participants,
  };
}

export function unresolvedMemorySessionTarget(
  agentId: string,
  sessionId: string,
): MemorySessionTarget {
  return {
    agentId,
    sessionId,
    resolution: "unresolved",
    hookExternalContentSource: null,
    channel: null,
    accountId: null,
    chatType: null,
    participants: [],
  };
}

export function resolveMemorySessionSince(
  since: MemorySessionSelectors["since"],
): number | undefined {
  const resolved = typeof since === "string" ? Date.parse(since) : since;
  if (resolved !== undefined && !Number.isFinite(resolved)) {
    throw new Error(`Invalid memory session date: ${since}`);
  }
  return resolved;
}

/** Resolve explicit memory-forget selectors against authoritative session owners. */
export function readMemorySessionTargets(
  params: MemorySessionSelectors & { env?: NodeJS.ProcessEnv },
  continuation?: CanonicalSessionReaderContinuation,
): MemorySessionTarget[] {
  const sessionIds = [...new Set(params.sessionIds ?? [])];
  const hookSources = [...new Set(params.hookSources ?? [])];
  const participants = [...new Set(params.participants ?? [])];
  if (sessionIds.length === 0 && hookSources.length === 0 && participants.length === 0) {
    return [];
  }
  const since = resolveMemorySessionSince(params.since);
  const resolvedSelectors = new Set<string>();
  const participantRecords = listSessionParticipantsReadOnly(params);
  const targets = new Map<string, MemorySessionTarget>();
  const instances = listSessionTranscriptInstances(
    params,
    { includeAllWindows: true },
    continuation,
  )
    .filter((instance) => instance.agentId === normalizeAgentId(params.agentId))
    .toSorted(
      (left, right) =>
        left.sourceMetadata.createdAt - right.sourceMetadata.createdAt ||
        left.sessionId.localeCompare(right.sessionId),
    );
  for (const instance of instances) {
    const identities = (participantRecords.get(instance.sessionKey) ?? []).map(
      ({ identity }) => identity,
    );
    const source = instance.sourceMetadata.hookExternalContentSource;
    if (
      !sessionIds.includes(instance.sessionId) &&
      !sessionIds.includes(instance.sessionKey) &&
      !(source && hookSources.includes(source)) &&
      !identities.some((identity) => participants.includes(identity.id))
    ) {
      continue;
    }
    resolvedSelectors.add(instance.sessionId);
    resolvedSelectors.add(instance.sessionKey);
    if (since === undefined || instance.sourceMetadata.createdAt >= since) {
      targets.set(instance.sessionId, projectSessionMetadata(instance, identities));
    }
  }
  for (const archive of listSessionTranscriptArchivesReadOnly({ ...params, sessionIds })) {
    resolvedSelectors.add(archive.sessionId);
    resolvedSelectors.add(archive.sessionKey);
    if (targets.has(archive.sessionId) || (since !== undefined && archive.createdAt < since)) {
      continue;
    }
    targets.set(archive.sessionId, {
      agentId: params.agentId,
      sessionId: archive.sessionId,
      sessionKey: archive.sessionKey,
      resolution: "archived",
      hookExternalContentSource: null,
      channel: null,
      accountId: null,
      chatType: null,
      createdAt: archive.createdAt,
      participants: [],
    });
  }
  for (const sessionId of sessionIds) {
    if (!resolvedSelectors.has(sessionId)) {
      targets.set(sessionId, unresolvedMemorySessionTarget(params.agentId, sessionId));
    }
  }
  return [...targets.values()];
}
