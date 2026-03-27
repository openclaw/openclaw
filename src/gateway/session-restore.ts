import fs from "node:fs";
import path from "node:path";
import { stripInboundMetadata } from "../auto-reply/reply/strip-inbound-meta.js";
import {
  extractSessionIdFromArchiveName,
  isSessionArchiveArtifactName,
  parseSessionArchiveTimestamp,
  type SessionArchiveReason,
} from "../config/sessions/artifacts.js";
import { resolveSessionTranscriptPathInDir } from "../config/sessions/paths.js";
import { stripEnvelope } from "./chat-sanitize.js";
import { performGatewaySessionReset } from "./session-reset-service.js";

export type ArchivedSession = {
  index: number;
  fileName: string;
  filePath: string;
  timestamp: number;
  reason: SessionArchiveReason;
  sessionId: string;
  firstUserMessage: string | null;
};

const HEAD_BYTES = 32768;
const MAX_LINES_TO_SCAN = 20;

function extractText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }
  return null;
}

/**
 * Reads the JSONL header from a transcript file and returns the sessionKey if present.
 * Reads only the first ~512 bytes to parse the header line.
 */
function readSessionKeyFromHeader(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(512);
    const bytesRead = fs.readSync(fd, buf, 0, 512, 0);
    if (bytesRead === 0) {
      return null;
    }
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const firstLine = chunk.split(/\r?\n/)[0];
    if (!firstLine?.trim()) {
      return null;
    }
    const parsed = JSON.parse(firstLine);
    return typeof parsed?.sessionKey === "string" ? parsed.sessionKey : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Reads the first user message from a transcript file for preview purposes.
 */
function readFirstUserMessageFromFile(filePath: string): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    if (bytesRead === 0) {
      return null;
    }
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const lines = chunk.split(/\r?\n/).slice(0, MAX_LINES_TO_SCAN);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        const msg = parsed?.message;
        if (msg?.role !== "user") {
          continue;
        }
        const content = msg.content;
        const rawText = extractText(content);
        if (!rawText) {
          continue;
        }
        // Skip inter-session system messages (e.g. "A new session was started via /new")
        if (rawText.startsWith("A new session was started via /new or /reset")) {
          continue;
        }
        // Strip all OpenClaw-injected metadata blocks and envelope prefix
        let text = stripInboundMetadata(rawText).trim();
        // Remove "User text:" label left after metadata stripping
        text = text.replace(/^User text:\n?/, "");
        text = stripEnvelope(text).trim();
        if (!text) {
          continue;
        }
        return text;
      } catch {
        // skip malformed lines
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Lists recent archived session transcripts for a given session key.
 * Only returns archives whose JSONL header contains a matching sessionKey field.
 */
export function listRecentArchives(params: {
  sessionsDir: string;
  sessionKey: string;
  limit?: number;
}): ArchivedSession[] {
  const { sessionsDir, sessionKey, limit = 10 } = params;

  let entries: string[];
  try {
    entries = fs.readdirSync(sessionsDir);
  } catch {
    return [];
  }

  // Parse timestamps from filenames (no file I/O yet)
  const candidates: Array<{
    fileName: string;
    timestamp: number;
    reason: SessionArchiveReason;
    sessionId: string;
  }> = [];

  for (const fileName of entries) {
    if (!isSessionArchiveArtifactName(fileName) || !fileName.includes(".jsonl.")) {
      continue;
    }
    const sessionId = extractSessionIdFromArchiveName(fileName);
    if (!sessionId) {
      continue;
    }

    let timestamp: number | null = null;
    let reason: SessionArchiveReason | null = null;
    for (const r of ["reset", "deleted"] as const) {
      const ts = parseSessionArchiveTimestamp(fileName, r);
      if (ts != null) {
        timestamp = ts;
        reason = r;
        break;
      }
    }
    if (timestamp == null || reason == null) {
      continue;
    }

    candidates.push({ fileName, timestamp, reason, sessionId });
  }

  // Sort by timestamp descending (most recent first)
  candidates.sort((a, b) => b.timestamp - a.timestamp);

  // Filter by sessionKey from JSONL header, collect up to limit.
  // Cap the scan to avoid O(total-archives) I/O in multi-channel deployments.
  const scanCeiling = Math.max(limit * 10, 50);
  const result: ArchivedSession[] = [];
  for (const candidate of candidates.slice(0, scanCeiling)) {
    if (result.length >= limit) {
      break;
    }
    const filePath = path.join(sessionsDir, candidate.fileName);
    const headerSessionKey = readSessionKeyFromHeader(filePath);
    // Match by sessionKey when present; include archives without sessionKey
    // as a fallback (pre-feature archives that predate sessionKey headers).
    if (headerSessionKey !== null && headerSessionKey !== sessionKey) {
      continue;
    }
    const firstUserMessage = readFirstUserMessageFromFile(filePath);
    result.push({
      index: result.length + 1,
      fileName: candidate.fileName,
      filePath,
      timestamp: candidate.timestamp,
      reason: candidate.reason,
      sessionId: candidate.sessionId,
      firstUserMessage,
    });
  }

  return result;
}

/**
 * Restores an archived session transcript into the current session.
 * Calls performGatewaySessionReset (same as /new) to close the current session,
 * then renames the selected archive to match the new session UUID.
 */
export async function performSessionRestore(params: {
  key: string;
  archiveFilePath: string;
  sessionsDir: string;
  commandSource: string;
  /** Thread/topic ID for thread-scoped sessions (resolves to {id}-topic-{topicId}.jsonl). */
  topicId?: string | number;
}): Promise<{ ok: true; key: string; sessionId: string } | { ok: false; error: string }> {
  if (!fs.existsSync(params.archiveFilePath)) {
    return { ok: false, error: "Archive file no longer exists." };
  }

  // Reset the current session (same as /new)
  const resetResult = await performGatewaySessionReset({
    key: params.key,
    reason: "new",
    commandSource: params.commandSource,
  });
  if (!resetResult.ok) {
    return { ok: false, error: "Failed to reset current session." };
  }

  const newSessionId = resetResult.entry.sessionId;
  // Use topic-aware path so thread/topic sessions resolve to the correct file.
  const targetPath = resolveSessionTranscriptPathInDir(
    newSessionId,
    params.sessionsDir,
    params.topicId,
  );

  try {
    // Reset eagerly creates a fresh transcript file. Remove that placeholder
    // first so restore behaves consistently on platforms where rename() does
    // not replace an existing destination file.
    fs.rmSync(targetPath, { force: true });
    // Note: the in-file JSONL header still contains the original archived session's "id"
    // field after rename. This is intentional — the file path is the canonical reference,
    // not the header ID. ensureSessionHeader skips re-writing when the file already exists.
    fs.renameSync(params.archiveFilePath, targetPath);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to restore archive: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, key: resetResult.key, sessionId: newSessionId };
}
