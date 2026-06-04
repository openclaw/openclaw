import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { parseSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptCandidates } from "./session-utils.js";

export type SessionTranscriptReadTarget = {
  sessionId: string;
  sessionFile?: string;
  applySessionStartedAtFilter: boolean;
};

export type SessionHistoryFamilyEntry = {
  sessionId?: string;
  sessionFile?: string;
  usageFamilySessionIds?: string[];
};

export function resolveHistoryFamilySessionIds(
  entry: Pick<SessionHistoryFamilyEntry, "usageFamilySessionIds"> | undefined,
  currentSessionId: string,
): string[] {
  const withoutCurrent = (entry?.usageFamilySessionIds ?? []).filter(
    (sessionId) => sessionId !== currentSessionId,
  );
  return uniqueStrings([...withoutCurrent, currentSessionId]);
}

export function isResetArchiveForSession(fileName: string, sessionId: string): boolean {
  if (parseSessionArchiveTimestamp(fileName, "reset") == null) {
    return false;
  }
  return (
    fileName.startsWith(sessionId + ".jsonl.reset.") || fileName.startsWith(sessionId + "-topic-")
  );
}

export function resolveFirstExistingTranscriptCandidate(params: {
  sessionId: string;
  storePath: string | undefined;
  sessionFile?: string;
  agentId?: string;
}): string | undefined {
  return resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  ).find((candidate) => fs.existsSync(candidate));
}

export async function discoverResetArchiveTranscriptFiles(params: {
  sessionId: string;
  storePath: string | undefined;
}): Promise<string[]> {
  if (!params.storePath) {
    return [];
  }
  const sessionsDir = path.dirname(params.storePath);
  const entries = await fs.promises.readdir(sessionsDir).catch(() => []);
  return entries
    .filter((entry) => isResetArchiveForSession(entry, params.sessionId))
    .toSorted((a, b) => {
      const aTs = parseSessionArchiveTimestamp(a, "reset") ?? 0;
      const bTs = parseSessionArchiveTimestamp(b, "reset") ?? 0;
      return aTs - bTs || a.localeCompare(b);
    })
    .map((entry) => path.join(sessionsDir, entry));
}

export async function resolveSessionFamilyTranscriptReadTargets(params: {
  entry: SessionHistoryFamilyEntry | undefined;
  sessionId: string | undefined;
  storePath: string | undefined;
  agentId?: string;
  includeFamily: boolean;
}): Promise<SessionTranscriptReadTarget[]> {
  if (!params.sessionId) {
    return [];
  }
  const sessionIds = params.includeFamily
    ? resolveHistoryFamilySessionIds(params.entry, params.sessionId)
    : [params.sessionId];
  const targets: SessionTranscriptReadTarget[] = [];
  const seenFiles = new Set<string>();
  for (const familySessionId of sessionIds) {
    const archivedFiles = params.includeFamily
      ? await discoverResetArchiveTranscriptFiles({
          sessionId: familySessionId,
          storePath: params.storePath,
        })
      : [];
    const activeFile = resolveFirstExistingTranscriptCandidate({
      sessionId: familySessionId,
      storePath: params.storePath,
      sessionFile: familySessionId === params.sessionId ? params.entry?.sessionFile : undefined,
      agentId: params.agentId,
    });
    for (const file of archivedFiles) {
      const resolved = path.resolve(file);
      if (seenFiles.has(resolved)) {
        continue;
      }
      seenFiles.add(resolved);
      targets.push({
        sessionId: familySessionId,
        sessionFile: resolved,
        applySessionStartedAtFilter: false,
      });
    }
    if (activeFile) {
      const resolved = path.resolve(activeFile);
      if (seenFiles.has(resolved)) {
        continue;
      }
      seenFiles.add(resolved);
      targets.push({
        sessionId: familySessionId,
        sessionFile: resolved,
        applySessionStartedAtFilter: familySessionId === params.sessionId,
      });
    }
  }
  return targets;
}
