import fs from "node:fs";
import { resolveSessionTranscriptCandidates } from "./session-utils.fs.js";

const LAST_ENTRY_MAX_BYTES = 32768;
const LAST_ENTRY_MAX_LINES = 50;

type TranscriptEntry = {
  id?: string;
  parentId?: string | null;
  type?: string;
  message?: {
    role?: string;
  };
};

/**
 * Reads the transcript file and returns the ID of the last entry in the current branch.
 * This is used to set the parentId when injecting messages after a gateway restart,
 * ensuring the conversation history chain is preserved.
 *
 * @param sessionId - The session ID
 * @param storePath - The path to the session store
 * @param sessionFile - Optional explicit session file path
 * @param agentId - Optional agent ID for path resolution
 * @returns The ID of the last entry, or null if not found
 */
export function readSessionLeafId(
  sessionId: string,
  storePath: string | undefined,
  sessionFile?: string,
  agentId?: string,
): string | null {
  const candidates = resolveSessionTranscriptCandidates(sessionId, storePath, sessionFile, agentId);
  const filePath = candidates.find((p) => fs.existsSync(p));
  if (!filePath) {
    return null;
  }

  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    if (size === 0) {
      return null;
    }

    // Read from the end of the file to find the last entry with an ID
    const readStart = Math.max(0, size - LAST_ENTRY_MAX_BYTES);
    const readLen = Math.min(size, LAST_ENTRY_MAX_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, readStart);

    const chunk = buf.toString("utf-8");
    const lines = chunk.split(/\r?\n/).filter((l) => l.trim());
    const tailLines = lines.slice(-LAST_ENTRY_MAX_LINES);

    // Iterate from the end to find the last entry with an ID
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const line = tailLines[i];
      try {
        const parsed = JSON.parse(line) as TranscriptEntry;
        // Look for entries with an ID (message entries, not session headers)
        if (parsed?.id && typeof parsed.id === "string") {
          return parsed.id;
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file error
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
  return null;
}
