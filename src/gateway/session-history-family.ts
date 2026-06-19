import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  resolveSessionTranscriptCandidates,
  resolveSessionTranscriptResetArchiveCandidatesAsync,
} from "./session-transcript-files.fs.js";
import { resolveSessionHistoryTranscriptPathAsync } from "./session-utils.fs.js";

export type SessionTranscriptReadTarget = {
  sessionId: string;
  sessionFile?: string;
  applySessionStartedAtFilter: boolean;
  isCurrentActive?: boolean;
  useStoreEntryFallback?: boolean;
};

export type SessionHistoryFamilyEntry = {
  sessionId?: string;
  sessionFile?: string;
  usageFamilySessionIds?: string[];
};

export const MAX_SESSION_FAMILY_TRANSCRIPT_READ_TARGETS = 32;

export function resolveHistoryFamilySessionIds(
  entry: Pick<SessionHistoryFamilyEntry, "usageFamilySessionIds"> | undefined,
  currentSessionId: string,
): string[] {
  const withoutCurrent = (entry?.usageFamilySessionIds ?? []).filter(
    (sessionId) => sessionId !== currentSessionId,
  );
  return uniqueStrings([...withoutCurrent, currentSessionId]);
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

function orderFamilyReadTargetsForOutput(
  targets: SessionTranscriptReadTarget[],
  currentSessionId: string,
): SessionTranscriptReadTarget[] {
  return targets
    .map((target, index) => ({ target, index }))
    .toSorted((left, right) => {
      const leftRank =
        left.target.sessionId !== currentSessionId ? 0 : left.target.isCurrentActive ? 2 : 1;
      const rightRank =
        right.target.sessionId !== currentSessionId ? 0 : right.target.isCurrentActive ? 2 : 1;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ target }) => target);
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
  const currentSessionId = params.sessionId;
  const sessionIds = params.includeFamily
    ? resolveHistoryFamilySessionIds(params.entry, currentSessionId)
    : [currentSessionId];
  const targets: SessionTranscriptReadTarget[] = [];
  const seenFiles = new Set<string>();
  const pushTarget = (target: SessionTranscriptReadTarget, limit: number): boolean => {
    if (targets.length >= limit) {
      return false;
    }
    const resolved = target.sessionFile ? path.resolve(target.sessionFile) : undefined;
    if (resolved && seenFiles.has(resolved)) {
      return true;
    }
    if (resolved) {
      seenFiles.add(resolved);
    }
    targets.push({ ...target, ...(resolved ? { sessionFile: resolved } : {}) });
    return targets.length < limit;
  };

  for (const familySessionId of sessionIds) {
    const targetLimit =
      params.includeFamily && familySessionId !== currentSessionId
        ? MAX_SESSION_FAMILY_TRANSCRIPT_READ_TARGETS - 2
        : MAX_SESSION_FAMILY_TRANSCRIPT_READ_TARGETS;
    if (targets.length >= targetLimit && familySessionId !== currentSessionId) {
      continue;
    }
    const archivedFiles = params.includeFamily
      ? await resolveSessionTranscriptResetArchiveCandidatesAsync(
          familySessionId,
          params.storePath,
          familySessionId === currentSessionId ? params.entry?.sessionFile : undefined,
          params.agentId,
        )
      : [];
    const activeFile =
      params.includeFamily || familySessionId !== currentSessionId
        ? resolveFirstExistingTranscriptCandidate({
            sessionId: familySessionId,
            storePath: params.storePath,
            sessionFile:
              familySessionId === currentSessionId ? params.entry?.sessionFile : undefined,
            agentId: params.agentId,
          })
        : await resolveSessionHistoryTranscriptPathAsync(
            familySessionId,
            params.storePath,
            params.entry?.sessionFile,
            {
              agentId: params.agentId,
              allowResetArchiveFallback: true,
            },
          );

    if (!params.includeFamily && familySessionId === currentSessionId && !activeFile) {
      pushTarget(
        {
          sessionId: familySessionId,
          ...(params.entry?.sessionFile ? { sessionFile: params.entry.sessionFile } : {}),
          applySessionStartedAtFilter: true,
          isCurrentActive: true,
          useStoreEntryFallback: true,
        },
        targetLimit,
      );
      continue;
    }

    const archiveTargetLimit =
      params.includeFamily && familySessionId === currentSessionId && activeFile
        ? Math.max(0, targetLimit - 1)
        : targetLimit;
    for (const file of archivedFiles) {
      if (
        !pushTarget(
          {
            sessionId: familySessionId,
            sessionFile: file,
            applySessionStartedAtFilter: false,
          },
          archiveTargetLimit,
        )
      ) {
        break;
      }
    }
    if (activeFile) {
      pushTarget(
        {
          sessionId: familySessionId,
          sessionFile: activeFile,
          applySessionStartedAtFilter: familySessionId === currentSessionId,
          ...(familySessionId === currentSessionId ? { isCurrentActive: true } : {}),
        },
        targetLimit,
      );
    }
  }
  return params.includeFamily
    ? orderFamilyReadTargetsForOutput(targets, currentSessionId)
    : targets;
}
