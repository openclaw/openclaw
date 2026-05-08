import path from "node:path";
import { resolveSessionFilePath, resolveSessionTranscriptPath } from "../config/sessions/paths.js";

function classifySessionTranscriptCandidate(
  sessionId: string,
  sessionFile?: string,
): "current" | "stale" | "custom" {
  const transcriptSessionId = extractGeneratedTranscriptSessionId(sessionFile);
  if (!transcriptSessionId) {
    return "custom";
  }
  return transcriptSessionId === sessionId ? "current" : "stale";
}

function extractGeneratedTranscriptSessionId(sessionFile?: string): string | undefined {
  const trimmed = sessionFile?.trim();
  if (!trimmed) {
    return undefined;
  }
  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }
  const withoutExt = base.slice(0, -".jsonl".length);
  const topicIndex = withoutExt.indexOf("-topic-");
  if (topicIndex > 0) {
    const topicSessionId = withoutExt.slice(0, topicIndex);
    return looksLikeGeneratedSessionId(topicSessionId) ? topicSessionId : undefined;
  }
  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T[\w-]+(?:Z|[+-]\d{2}(?:-\d{2})?)?)_(.+)$/,
  );
  if (forkMatch?.[2]) {
    return looksLikeGeneratedSessionId(forkMatch[2]) ? forkMatch[2] : undefined;
  }
  return looksLikeGeneratedSessionId(withoutExt) ? withoutExt : undefined;
}

function looksLikeGeneratedSessionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  sessionFile?: string,
  agentId?: string,
): string[] {
  const candidates: string[] = [];
  const sessionFileState = classifySessionTranscriptCandidate(sessionId, sessionFile);
  const pushCandidate = (resolve: () => string): void => {
    try {
      candidates.push(resolve());
    } catch {
      // Ignore invalid paths/IDs and keep scanning other safe candidates.
    }
  };

  if (sessionFile) {
    if (agentId) {
      if (sessionFileState === "custom") {
        const trimmed = sessionFile.trim();
        if (trimmed) {
          candidates.push(path.resolve(trimmed));
        }
      } else if (sessionFileState !== "stale") {
        pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
      }
    } else {
      const trimmed = sessionFile.trim();
      if (trimmed) {
        candidates.push(path.resolve(trimmed));
      }
    }
  }

  if (agentId) {
    pushCandidate(() => resolveSessionTranscriptPath(sessionId, agentId));
    if (sessionFile && sessionFileState === "stale") {
      pushCandidate(() => resolveSessionFilePath(sessionId, { sessionFile }, { agentId }));
    }
  }

  return Array.from(new Set(candidates));
}

export function resolveStableSessionEndTranscript(params: {
  sessionId: string;
  sessionFile?: string;
  agentId?: string;
}): { sessionFile?: string } {
  const stablePath = params.sessionFile?.trim();
  if (stablePath) {
    return { sessionFile: path.resolve(stablePath) };
  }

  const [candidate] = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.sessionFile,
    params.agentId,
  );
  return candidate ? { sessionFile: path.resolve(candidate) } : {};
}
