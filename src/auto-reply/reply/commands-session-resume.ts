import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  MAX_SESSION_HISTORY,
  parseSessionArchiveTimestamp,
  updateSessionStore,
} from "../../config/sessions.js";
import type { SessionHistoryEntry } from "../../config/sessions.js";
import {
  resolveSessionEntryLabel,
  resolveSessionTranscriptCandidates,
} from "../../gateway/session-utils.fs.js";
import { formatRelativeTimestamp } from "../../infra/format-time/format-relative.js";
import type { CommandHandler } from "./commands-types.js";

const MAX_HISTORY_DISPLAY = 10;

async function restoreSessionTranscript(
  entry: SessionHistoryEntry,
  storePath: string | undefined,
  agentId: string | undefined,
): Promise<string | undefined> {
  const sessionsDir = storePath ? path.dirname(storePath) : undefined;
  const candidates = resolveSessionTranscriptCandidates(
    entry.sessionId,
    storePath,
    entry.sessionFile,
    agentId,
  );

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (!sessionsDir) {
      return candidate;
    }
    const candidateResolved = path.resolve(candidate);
    const sessionsDirResolved = path.resolve(sessionsDir);
    const relative = path.relative(sessionsDirResolved, candidateResolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return candidate;
    }
    const targetPath = path.join(sessionsDirResolved, path.basename(candidate));
    try {
      await fsPromises.mkdir(sessionsDirResolved, { recursive: true });
      await fsPromises.copyFile(candidate, targetPath);
      return targetPath;
    } catch {
      continue;
    }
  }

  const fileBasename = entry.sessionFile
    ? path.basename(entry.sessionFile)
    : `${entry.sessionId}.jsonl`;
  const archivePrefix = `${fileBasename}.reset.`;
  const searchDirs = Array.from(
    new Set([
      ...(sessionsDir ? [sessionsDir] : []),
      ...candidates.map((candidate) => path.dirname(candidate)),
    ]),
  );

  let newestArchive: { dir: string; file: string; ts: number } | undefined;
  for (const dir of searchDirs) {
    const files = await fsPromises.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.startsWith(archivePrefix)) {
        continue;
      }
      const ts = parseSessionArchiveTimestamp(file, "reset");
      if (ts === null) {
        continue;
      }
      if (!newestArchive || ts > newestArchive.ts) {
        newestArchive = { dir, file, ts };
      }
    }
  }

  if (!newestArchive) {
    return undefined;
  }

  const archivedPath = path.join(newestArchive.dir, newestArchive.file);
  const primaryDir = sessionsDir ?? newestArchive.dir;
  const restoredPath = path.join(primaryDir, fileBasename);
  try {
    await fsPromises.rename(archivedPath, restoredPath);
    return restoredPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV" || primaryDir === newestArchive.dir) {
      return undefined;
    }
  }

  try {
    await fsPromises.copyFile(archivedPath, restoredPath);
  } catch {
    return undefined;
  }
  await fsPromises.unlink(archivedPath).catch(() => undefined);
  return restoredPath;
}

function parseResumeIndex(target: string): number | undefined {
  const match = /^#(\d+)$/.exec(target);
  if (!match) {
    return undefined;
  }
  return Number(match[1]);
}

export const handleResumeCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!/^\/resume(?:\s|$)/i.test(normalized)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    return { shouldContinue: false };
  }

  const target = normalized.slice("/resume".length).trim();
  const history: SessionHistoryEntry[] = params.sessionEntry?.history ?? [];

  if (!target) {
    if (history.length === 0) {
      return {
        shouldContinue: false,
        reply: { text: "No previous sessions found." },
      };
    }
    const items = history.slice(0, MAX_HISTORY_DISPLAY);
    const lines = items.map((entry, i) => {
      const date = formatRelativeTimestamp(entry.updatedAt, { dateFallback: true });
      const label = entry.label ? ` - ${entry.label}` : "";
      return `${i + 1}. \`${entry.sessionId.slice(0, 8)}\` ${date}${label}`;
    });
    return {
      shouldContinue: false,
      reply: {
        text: `Recent sessions:\n${lines.join("\n")}\n\nUse /resume #<index> or /resume <id> to switch.`,
      },
    };
  }

  const index = parseResumeIndex(target);
  const targetId = target.toLowerCase();
  const match =
    typeof index === "number" && Number.isFinite(index) && index >= 1 && index <= history.length
      ? history[index - 1]
      : history.find(
          (item) =>
            item.sessionId.toLowerCase() === targetId ||
            item.sessionId.slice(0, 8).toLowerCase() === targetId,
        );

  if (!match) {
    return {
      shouldContinue: false,
      reply: {
        text: `Session not found: \`${target}\`. Use /resume to list recent sessions.`,
      },
    };
  }

  const { storePath, agentId } = params;
  const restoredFile = await restoreSessionTranscript(match, storePath, agentId);
  if (!restoredFile) {
    return {
      shouldContinue: false,
      reply: {
        text: `Transcript for session \`${match.sessionId.slice(0, 8)}\` not found on disk.`,
      },
    };
  }

  const currentEntry = params.sessionEntry;
  const updatedHistory: SessionHistoryEntry[] = [
    ...(currentEntry
      ? [
          {
            sessionId: currentEntry.sessionId,
            sessionFile: currentEntry.sessionFile,
            updatedAt: currentEntry.updatedAt,
            label: resolveSessionEntryLabel(currentEntry, storePath, agentId),
            systemSent: currentEntry.systemSent,
          },
        ]
      : []),
    ...history.filter((item) => item.sessionId !== match.sessionId),
  ].slice(0, MAX_SESSION_HISTORY);

  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      const existing = store[params.sessionKey] ?? {};
      store[params.sessionKey] = {
        ...existing,
        sessionId: match.sessionId,
        sessionFile: restoredFile,
        updatedAt: Date.now(),
        systemSent: match.systemSent,
        history: updatedHistory,
        totalTokens: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextTokens: undefined,
        estimatedCostUsd: undefined,
        abortedLastRun: false,
        abortCutoffMessageSid: undefined,
        abortCutoffTimestamp: undefined,
        compactionCount: 0,
        memoryFlushCompactionCount: undefined,
        memoryFlushAt: undefined,
        fallbackNoticeSelectedModel: undefined,
        fallbackNoticeActiveModel: undefined,
        fallbackNoticeReason: undefined,
        systemPromptReport: undefined,
      };
    });
  }

  const shortId = match.sessionId.slice(0, 8);
  return {
    shouldContinue: false,
    reply: {
      text: `Resumed session \`${shortId}\`. Your next message will continue that conversation.`,
    },
  };
};
