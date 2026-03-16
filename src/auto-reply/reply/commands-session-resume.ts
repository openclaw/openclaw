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

  // 1. Check if transcript already exists at known candidates.
  // If found outside the primary sessions dir, copy it in so that
  // initSessionState's resolveAndPersistSessionFile does not re-normalize
  // sessionFile to a different (empty) path and drop the resumed context
  // after one message.
  const candidates = resolveSessionTranscriptCandidates(
    entry.sessionId,
    storePath,
    entry.sessionFile,
    agentId,
  );
  for (const cand of candidates) {
    if (!fs.existsSync(cand)) {
      continue;
    }
    if (!sessionsDir) {
      return cand;
    }
    const candResolved = path.resolve(cand);
    const dirResolved = path.resolve(sessionsDir);
    const relative = path.relative(dirResolved, candResolved);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      // Inside primary sessions dir — but probe entry.sessionFile raw path before
      // accepting this as the authoritative transcript. resolveSessionTranscriptCandidates
      // may have normalized it away (e.g. mapped a legacy topic path to the primary dir),
      // so the raw path may not appear in candidates even when it still holds the real
      // transcript on disk (e.g. migrated/legacy states where this normalized path is
      // only a placeholder or partial stub).
      if (entry.sessionFile) {
        const rawPath = path.resolve(entry.sessionFile.trim());
        if (rawPath && !candidates.includes(rawPath) && fs.existsSync(rawPath)) {
          const rawRelative = path.relative(dirResolved, rawPath);
          if (!rawRelative.startsWith("..") && !path.isAbsolute(rawRelative)) {
            // Raw path is also inside sessionsDir.
            return rawPath;
          }
          // External raw path: copy it in so the location stays stable across turns.
          const targetPath = path.join(dirResolved, path.basename(rawPath));
          try {
            await fsPromises.mkdir(dirResolved, { recursive: true });
            await fsPromises.copyFile(rawPath, targetPath);
            return targetPath;
          } catch {
            // Copy failed — fall through to return the normalized candidate.
          }
        }
      }
      return cand;
    }
    // External candidate: copy into primary sessions dir so the path stays
    // stable across turns. Mirror the cross-filesystem fallback used for
    // archived restores below.
    const targetPath = path.join(dirResolved, path.basename(cand));
    try {
      await fsPromises.mkdir(dirResolved, { recursive: true });
      await fsPromises.copyFile(cand, targetPath);
      return targetPath;
    } catch {
      // Copy failed — continue to next candidate or fall through to archive scan.
      continue;
    }
  }

  // 1.5. Probe entry.sessionFile directly — resolveSessionTranscriptCandidates normalizes
  // this path (e.g. maps a legacy topic transcript to the primary sessions dir), so the
  // raw path may not appear in candidates even when the file still exists on disk there.
  if (entry.sessionFile) {
    const raw = path.resolve(entry.sessionFile.trim());
    if (raw && !candidates.includes(raw) && fs.existsSync(raw)) {
      if (!sessionsDir) {
        return raw;
      }
      const dirResolved = path.resolve(sessionsDir);
      const relative = path.relative(dirResolved, raw);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        return raw;
      }
      // External path: copy into sessionsDir so the location stays stable across turns.
      const targetPath = path.join(dirResolved, path.basename(raw));
      try {
        await fsPromises.mkdir(dirResolved, { recursive: true });
        await fsPromises.copyFile(raw, targetPath);
        return targetPath;
      } catch {
        // Copy failed — fall through to archive scan.
      }
    }
  }

  // 2. Look for the newest .reset.* archive across all candidate directories.
  // archiveSessionTranscripts uses resolveSessionTranscriptCandidates (which includes
  // the legacy ~/.openclaw/sessions dir) so we must search the same set of directories.
  // Use the original filename as prefix so topic/thread sessions (e.g. <id>-topic-<n>.jsonl)
  // are found after archiving, not just the default <sessionId>.jsonl pattern.
  const fileBasename = entry.sessionFile
    ? path.basename(entry.sessionFile)
    : `${entry.sessionId}.jsonl`;
  const prefix = `${fileBasename}.reset.`;

  // Always include sessionsDir; add extra dirs from candidates (e.g. legacy path).
  // Also include the raw directory of entry.sessionFile: resolveSessionTranscriptCandidates
  // may normalize that path away (e.g. remaps a legacy directory to sessionsDir), so its
  // original directory never appears in candidates — but archives may still live there.
  const rawSessionFileDir = entry.sessionFile
    ? path.dirname(path.resolve(entry.sessionFile.trim()))
    : undefined;
  const searchDirs = Array.from(
    new Set([
      ...(sessionsDir ? [sessionsDir] : []),
      ...candidates.map((c) => path.dirname(c)),
      ...(rawSessionFileDir ? [rawSessionFileDir] : []),
    ]),
  );
  if (searchDirs.length === 0) {
    return undefined;
  }

  let bestArchive: { dir: string; file: string; ts: number } | undefined;
  for (const dir of searchDirs) {
    const files = await fsPromises.readdir(dir).catch(() => [] as string[]);
    for (const f of files) {
      if (!f.startsWith(prefix)) {
        continue;
      }
      const ts = parseSessionArchiveTimestamp(f, "reset");
      if (ts === null) {
        continue;
      }
      if (!bestArchive || ts > bestArchive.ts) {
        bestArchive = { dir, file: f, ts };
      }
    }
  }

  if (!bestArchive) {
    return undefined;
  }

  const archivedPath = path.join(bestArchive.dir, bestArchive.file);
  // Always restore to primaryDir so the file is in a location that initSessionState
  // will not re-normalize away. On cross-filesystem moves (EXDEV), fall back to
  // copyFile + unlink rather than in-place restore: an in-place restore would leave
  // sessionFile pointing outside sessionsDir, causing initSessionState to create a
  // new empty file in sessionsDir that shadows the restored transcript after one turn.
  const primaryDir = sessionsDir ?? bestArchive.dir;
  const restoredPath = path.join(primaryDir, fileBasename);
  try {
    await fsPromises.rename(archivedPath, restoredPath);
    return restoredPath;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV" || primaryDir === bestArchive.dir) {
      return undefined;
    }
  }
  // Cross-filesystem: copy to primaryDir then remove the archive.
  // If copy fails, leave the archive intact and report not-found rather than
  // silently restoring to the wrong location.
  try {
    await fsPromises.copyFile(archivedPath, restoredPath);
  } catch {
    return undefined;
  }
  await fsPromises.unlink(archivedPath).catch(() => undefined);
  return restoredPath;
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

  // --- No argument: list recent sessions ---
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
      const label = entry.label ? ` — ${entry.label}` : "";
      return `${i + 1}. \`${entry.sessionId.slice(0, 8)}\` ${date}${label}`;
    });
    return {
      shouldContinue: false,
      reply: {
        text: `Recent sessions:\n${lines.join("\n")}\n\nUse /resume <id or #> to switch.`,
      },
    };
  }

  // --- With argument: switch to target session ---
  // Support numeric index (e.g. /resume 2 → history[1]) or exact 8-char session ID.
  // Short all-digit string → index; 8-char string → ID. Decoupled from history size.
  const numericIndex = target.length < 8 && /^\d+$/.test(target) ? Number(target) : NaN;
  const match =
    !Number.isNaN(numericIndex) && numericIndex >= 1 && numericIndex <= history.length
      ? history[numericIndex - 1]
      : history.find((h) => h.sessionId === target || h.sessionId.slice(0, 8) === target);
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

  // Build updated history: push current session in, remove the newly-resumed entry
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
    ...history.filter((h) => h.sessionId !== match.sessionId),
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
        // Clear stale per-run metrics
        totalTokens: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        contextTokens: undefined,
        estimatedCostUsd: undefined,
        abortedLastRun: false,
        // Clear abort cutoff: /stop on the outgoing session sets these fields and they
        // must not carry over — shouldSkipMessageByAbortCutoff evaluates them on the
        // next inbound message and would incorrectly drop the first resumed message when
        // message ID/timestamp spaces differ across session-key switches.
        abortCutoffMessageSid: undefined,
        abortCutoffTimestamp: undefined,
        // Clear compaction/flush state: these counters belong to the outgoing session
        // and must not carry over — otherwise the resumed session may be treated as
        // "already flushed" and skip needed memory flush behavior.
        compactionCount: 0,
        memoryFlushCompactionCount: undefined,
        memoryFlushAt: undefined,
        // Clear fallback notice state: the outgoing session's fallback context must not
        // carry over — stale values cause resolveFallbackTransition to emit a spurious
        // "fallback cleared" notice or suppress a notice that should fire for the resumed
        // conversation.
        fallbackNoticeSelectedModel: undefined,
        fallbackNoticeActiveModel: undefined,
        fallbackNoticeReason: undefined,
        // Clear system prompt report: /context returns source="run" reports immediately
        // without recomputing, so retaining the outgoing session's report would show the
        // wrong session's context breakdown until the next model run.
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
