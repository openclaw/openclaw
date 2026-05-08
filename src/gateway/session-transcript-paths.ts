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
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  const normalizedSessionFile = normalizeTranscriptLocator(sessionFile);
  if (normalizedSessionFile) {
    candidates.push(normalizedSessionFile);
  }

  if (agentId) {
    pushCandidate(() => createSqliteSessionTranscriptLocator({ sessionId, agentId }));
  }

  return Array.from(new Set(candidates));
}

export function resolveStableSessionEndTranscript(params: {
  sessionId: string;
  sessionFile?: string;
  agentId?: string;
}): { sessionFile?: string } {
  const stableLocator = normalizeTranscriptLocator(params.sessionFile);
  if (stableLocator) {
    return { sessionFile: stableLocator };
  }

  const [candidate] = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.sessionFile,
    params.agentId,
  );
  return candidate ? { sessionFile: candidate } : {};
}
