import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveSessionFilePath,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptPathInDir,
} from "../config/sessions/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";

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

function canonicalizePathForComparison(filePath: string): string {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function resolveSessionTranscriptCandidates(
  sessionId: string,
  storePath: string | undefined,
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

  if (storePath) {
    const sessionsDir = path.dirname(storePath);
    if (sessionFile && sessionFileState !== "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
    pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, sessionsDir));
    if (sessionFile && sessionFileState === "stale") {
      pushCandidate(() =>
        resolveSessionFilePath(sessionId, { sessionFile }, { sessionsDir, agentId }),
      );
    }
  } else if (sessionFile) {
    if (agentId) {
      if (sessionFileState !== "stale") {
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

  const home = resolveRequiredHomeDir(process.env, os.homedir);
  const legacyDir = path.join(home, ".openclaw", "sessions");
  pushCandidate(() => resolveSessionTranscriptPathInDir(sessionId, legacyDir));

  return Array.from(new Set(candidates));
}

export function resolveStableSessionEndTranscript(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): { sessionFile?: string } {
  const stablePath = params.sessionFile?.trim();
  if (stablePath) {
    return { sessionFile: path.resolve(stablePath) };
  }

  for (const candidate of resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  )) {
    const candidatePath = canonicalizePathForComparison(candidate);
    if (fs.existsSync(candidatePath)) {
      return { sessionFile: candidatePath };
    }
  }

  return {};
}
