import {
  createSqliteSessionTranscriptLocator,
  isSqliteSessionTranscriptLocator,
} from "../config/sessions/paths.js";

function normalizeTranscriptLocator(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && isSqliteSessionTranscriptLocator(trimmed) ? trimmed : undefined;
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  transcriptLocator?: string,
  agentId?: string,
  topicId?: string | number,
): string[] {
  const candidates: string[] = [];
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  const normalizedTranscriptLocator = normalizeTranscriptLocator(transcriptLocator);
  if (normalizedTranscriptLocator) {
    candidates.push(normalizedTranscriptLocator);
  }

  if (agentId) {
    pushCandidate(() => createSqliteSessionTranscriptLocator({ sessionId, agentId, topicId }));
  }

  return Array.from(new Set(candidates));
}

export function resolveStableSessionEndTranscript(params: {
  sessionId: string;
  transcriptLocator?: string;
  agentId?: string;
  topicId?: string | number;
}): { transcriptLocator?: string } {
  const stableLocator = normalizeTranscriptLocator(params.transcriptLocator);
  if (stableLocator) {
    return { transcriptLocator: stableLocator };
  }

  const [candidate] = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.transcriptLocator,
    params.agentId,
    params.topicId,
  );
  return candidate ? { transcriptLocator: candidate } : {};
}
