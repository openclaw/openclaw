/**
 * Per-session metadata storage to eliminate lock contention.
 *
 * Instead of storing all session metadata in a single sessions.json file
 * (which requires a global lock), each session gets its own .meta.json file.
 * This allows parallel updates without blocking.
 */

import JSON5 from "json5";
import fs from "node:fs/promises";
import path from "node:path";
import type { SessionEntry } from "./types.js";
import { resolveSessionTranscriptsDirForAgent } from "./paths.js";

const META_SUFFIX = ".meta.json";

/**
 * Get the path to a session's metadata file.
 */
export function getSessionMetaPath(sessionId: string, agentId?: string): string {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  return path.join(sessionsDir, `${sessionId}${META_SUFFIX}`);
}

/**
 * Load session metadata from per-session file.
 * Returns undefined if the file doesn't exist.
 */
export async function loadSessionMeta(
  sessionId: string,
  agentId?: string,
): Promise<SessionEntry | undefined> {
  const metaPath = getSessionMetaPath(sessionId, agentId);
  try {
    const content = await fs.readFile(metaPath, "utf-8");
    const entry = JSON5.parse(content);
    return entry;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

/**
 * Save session metadata to per-session file.
 * Uses atomic write (write to temp, then rename) to prevent corruption.
 */
export async function saveSessionMeta(
  sessionId: string,
  entry: SessionEntry,
  agentId?: string,
): Promise<void> {
  const metaPath = getSessionMetaPath(sessionId, agentId);
  const dir = path.dirname(metaPath);
  await fs.mkdir(dir, { recursive: true });

  // Atomic write: write to temp file, then rename
  const tempPath = `${metaPath}.tmp.${process.pid}.${Date.now()}`;
  const content = JSON.stringify(entry, null, 2);

  try {
    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, metaPath);
  } catch (err) {
    // Clean up temp file on error
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

/**
 * Update session metadata atomically.
 * Reads current state, applies patch, and writes back.
 * No lock needed since we use atomic writes and per-session files.
 */
export async function updateSessionMeta(
  sessionId: string,
  patch: Partial<SessionEntry>,
  agentId?: string,
): Promise<SessionEntry> {
  const existing = await loadSessionMeta(sessionId, agentId);
  const updatedAt = Date.now();
  const merged: SessionEntry = {
    ...existing,
    ...patch,
    sessionId,
    updatedAt,
  };
  await saveSessionMeta(sessionId, merged, agentId);
  return merged;
}

/**
 * Delete session metadata file.
 */
export async function deleteSessionMeta(sessionId: string, agentId?: string): Promise<void> {
  const metaPath = getSessionMetaPath(sessionId, agentId);
  await fs.unlink(metaPath).catch((err) => {
    if ((err as { code?: string }).code !== "ENOENT") {
      throw err;
    }
  });
}

/**
 * List all session metadata files in the sessions directory.
 * Returns an array of session IDs.
 */
export async function listSessionMetas(agentId?: string): Promise<string[]> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const files = await fs.readdir(sessionsDir);
    return files.filter((f) => f.endsWith(META_SUFFIX)).map((f) => f.slice(0, -META_SUFFIX.length));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

/**
 * Load all session metadata from per-session files.
 * This is used for backwards compatibility and for building the session index.
 */
export async function loadAllSessionMetas(agentId?: string): Promise<Record<string, SessionEntry>> {
  const sessionIds = await listSessionMetas(agentId);
  const entries: Record<string, SessionEntry> = {};

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      const entry = await loadSessionMeta(sessionId, agentId);
      if (entry) {
        entries[sessionId] = entry;
      }
    }),
  );

  return entries;
}
