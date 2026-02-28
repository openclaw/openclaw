import fs from "node:fs";
import path from "node:path";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import {
  isSessionArchiveArtifactName,
  isPrimarySessionTranscriptFileName,
  loadSessionStore,
  parseSessionArchiveTimestamp,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
  type SessionArchiveReason,
} from "../../config/sessions.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { validateSessionsArchivesParams } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export interface SessionArchiveEntry {
  sessionId: string;
  fileName: string;
  archiveReason?: string;
  archivedAt?: string;
  createdAt?: string;
  sizeBytes: number;
  messageCount?: number;
}

const ARCHIVE_REASONS: SessionArchiveReason[] = ["reset", "deleted", "bak"];
const MAX_FILE_SIZE_FOR_COUNT = 10 * 1024 * 1024; // 10MB

/**
 * Detect the archive reason from a filename suffix.
 * Returns "reset", "deleted", or "bak" if the file has that suffix,
 * or "orphaned" if it's a plain .jsonl that isn't referenced by an active session.
 */
function detectArchiveReason(fileName: string, isOrphan: boolean): string | undefined {
  for (const reason of ARCHIVE_REASONS) {
    if (parseSessionArchiveTimestamp(fileName, reason) !== null) {
      return reason;
    }
  }
  if (isOrphan) {
    return "orphaned";
  }
  return undefined;
}

/**
 * Extract the archivedAt timestamp from archive suffix, or fall back to file mtime.
 */
function resolveArchivedAt(fileName: string, mtimeMs: number): string | undefined {
  for (const reason of ARCHIVE_REASONS) {
    const ts = parseSessionArchiveTimestamp(fileName, reason);
    if (ts !== null) {
      return new Date(ts).toISOString();
    }
  }
  // For orphaned files, use file modification time.
  return new Date(mtimeMs).toISOString();
}

/**
 * Read the first JSONL line header to extract sessionId and timestamp.
 */
function readJsonlHeader(filePath: string): { id?: string; timestamp?: string } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    if (bytesRead === 0) {
      return {};
    }
    const chunk = buf.toString("utf-8", 0, bytesRead);
    const newlineIdx = chunk.indexOf("\n");
    const firstLine = newlineIdx >= 0 ? chunk.slice(0, newlineIdx) : chunk;
    if (!firstLine.trim()) {
      return {};
    }
    const parsed = JSON.parse(firstLine);
    return {
      id: typeof parsed?.id === "string" ? parsed.id : undefined,
      timestamp: typeof parsed?.timestamp === "string" ? parsed.timestamp : undefined,
    };
  } catch {
    return {};
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Count message lines in a JSONL file (lines containing `"message":`).
 * Only for files under the size threshold.
 */
function countMessages(filePath: string, sizeBytes: number): number | undefined {
  if (sizeBytes > MAX_FILE_SIZE_FOR_COUNT) {
    return undefined;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    let count = 0;
    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line);
        if (parsed?.message) {
          count++;
        }
      } catch {
        // ignore bad lines
      }
    }
    return count;
  } catch {
    return undefined;
  }
}

/**
 * Derive sessionId from filename by stripping .jsonl and any archive suffix.
 * E.g. "fa84d053-xxx.jsonl.reset.2026-02-26T01-06-04.374Z" -> "fa84d053-xxx"
 */
function sessionIdFromFileName(fileName: string): string {
  // Strip archive suffixes first: .reset.TIMESTAMP, .deleted.TIMESTAMP, .bak.TIMESTAMP
  let base = fileName;
  for (const reason of ARCHIVE_REASONS) {
    const marker = `.${reason}.`;
    const idx = base.lastIndexOf(marker);
    if (idx >= 0) {
      base = base.slice(0, idx);
      break;
    }
  }
  // Strip .jsonl extension
  if (base.endsWith(".jsonl")) {
    base = base.slice(0, -6);
  }
  return base;
}

export const sessionsArchivesHandlers: GatewayRequestHandlers = {
  "sessions.archives": async ({ params, respond }) => {
    if (!assertValidParams(params, validateSessionsArchivesParams, "sessions.archives", respond)) {
      return;
    }

    const cfg = loadConfig();
    const rawAgentId = params.agentId ?? resolveDefaultAgentId(cfg);
    const agentId = normalizeAgentId(rawAgentId);
    const limit = Math.min(params.limit ?? 50, 200);

    // Resolve the sessions directory for this agent.
    let sessionsDir: string;
    try {
      sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
    } catch {
      respond(true, { archives: [], total: 0 });
      return;
    }

    if (!fs.existsSync(sessionsDir)) {
      respond(true, { archives: [], total: 0 });
      return;
    }

    // Load the set of referenced session IDs from the store.
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    let referencedSessionIds: Set<string>;
    let referencedFiles: Set<string>;
    try {
      const store = loadSessionStore(storePath);
      referencedSessionIds = new Set<string>();
      referencedFiles = new Set<string>();
      for (const entry of Object.values(store)) {
        if (entry.sessionId) {
          referencedSessionIds.add(entry.sessionId);
        }
        if (entry.sessionFile) {
          referencedFiles.add(entry.sessionFile);
        }
      }
    } catch {
      referencedSessionIds = new Set();
      referencedFiles = new Set();
    }

    // Scan the directory for JSONL files.
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      respond(true, { archives: [], total: 0 });
      return;
    }

    const archives: SessionArchiveEntry[] = [];

    for (const dirent of dirEntries) {
      if (!dirent.isFile()) {
        continue;
      }
      const fileName = dirent.name;

      // Skip non-JSONL files.
      if (!fileName.includes(".jsonl")) {
        continue;
      }
      // Skip sessions.json, lock files, etc.
      if (fileName === "sessions.json" || fileName.endsWith(".lock")) {
        continue;
      }

      const isArchiveArtifact = isSessionArchiveArtifactName(fileName);
      const isPrimary = isPrimarySessionTranscriptFileName(fileName);

      if (!isArchiveArtifact && !isPrimary) {
        continue;
      }

      const filePath = path.join(sessionsDir, fileName);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }

      // Determine sessionId from header or filename.
      const derivedSessionId = sessionIdFromFileName(fileName);
      const header = readJsonlHeader(filePath);
      const sessionId = header.id || derivedSessionId;

      // Check if this is an active (referenced) session transcript.
      if (isPrimary && !isArchiveArtifact) {
        // It's a plain .jsonl file; check if it's orphaned.
        const isReferenced =
          referencedSessionIds.has(sessionId) ||
          referencedSessionIds.has(derivedSessionId) ||
          referencedFiles.has(fileName);
        if (isReferenced) {
          continue; // Active session, skip.
        }
      }

      const archiveReason = detectArchiveReason(fileName, isPrimary && !isArchiveArtifact);
      const archivedAt = resolveArchivedAt(fileName, stat.mtimeMs);
      const messageCount = countMessages(filePath, stat.size);

      archives.push({
        sessionId,
        fileName,
        archiveReason,
        archivedAt,
        createdAt: header.timestamp,
        sizeBytes: stat.size,
        messageCount,
      });
    }

    // Sort by archivedAt descending (most recent first).
    archives.sort((a, b) => {
      const ta = a.archivedAt ? new Date(a.archivedAt).getTime() : 0;
      const tb = b.archivedAt ? new Date(b.archivedAt).getTime() : 0;
      return tb - ta;
    });

    const total = archives.length;
    const sliced = archives.slice(0, limit);

    respond(true, { archives: sliced, total });
  },
};
