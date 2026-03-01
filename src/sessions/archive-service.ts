import fs from "node:fs/promises";
import path from "node:path";
import {
  formatSessionArchiveTimestamp,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
} from "../config/sessions.js";
import { resolveSessionTranscriptCandidates } from "../gateway/session-utils.fs.js";
import { USER_ARCHIVE_SHUTDOWN_REASON } from "../gateway/shutdown-state.js";

type ArchiveLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

function slugifySessionLabel(value: string): string {
  const lowered = value.trim().toLowerCase();
  const normalized = lowered
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "session";
}

async function resolveUniqueArchiveTarget(baseTargetPath: string): Promise<string> {
  let candidate = baseTargetPath;
  let suffix = 0;
  while (true) {
    try {
      await fs.stat(candidate);
      suffix += 1;
      const parsed = path.parse(baseTargetPath);
      candidate = path.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    } catch {
      return candidate;
    }
  }
}

export async function moveSessionToArchive(params: {
  sessionPath: string;
  archiveRoot: string;
  sessionSlug: string;
  nowMs?: number;
}): Promise<{ archiveDir: string; archivedPath: string }> {
  const timestamp = formatSessionArchiveTimestamp(params.nowMs);
  const archiveDir = params.archiveRoot;
  await fs.mkdir(archiveDir, { recursive: true });
  const fileName = `${timestamp}-${slugifySessionLabel(params.sessionSlug)}-${path.basename(params.sessionPath)}`;
  const targetBase = path.join(archiveDir, fileName);
  const archivedPath = await resolveUniqueArchiveTarget(targetBase);
  await fs.rename(params.sessionPath, archivedPath);
  return { archiveDir, archivedPath };
}

async function resolveExistingTranscriptPath(params: {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  agentId?: string;
}): Promise<string | null> {
  const candidates = resolveSessionTranscriptCandidates(
    params.sessionId,
    params.storePath,
    params.sessionFile,
    params.agentId,
  );
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Keep checking other transcript candidates.
    }
  }
  return null;
}

async function ensureTranscriptShell(params: {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  agentId?: string;
}): Promise<string | null> {
  let fallbackPath: string | null = null;
  if (params.storePath) {
    fallbackPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      resolveSessionFilePathOptions({
        agentId: params.agentId,
        storePath: params.storePath,
      }),
    );
  } else if (params.agentId || params.sessionFile) {
    fallbackPath = resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      params.agentId ? { agentId: params.agentId } : undefined,
    );
  }
  if (!fallbackPath) {
    return null;
  }
  await fs.mkdir(path.dirname(fallbackPath), { recursive: true });
  const header = {
    type: "session",
    id: params.sessionId,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  };
  try {
    await fs.writeFile(fallbackPath, `${JSON.stringify(header)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code !== "EEXIST") {
      throw err;
    }
  }
  return fallbackPath;
}

export async function archiveAndTerminateCurrentSession(params: {
  sessionKey: string;
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  agentId?: string;
  archiveRoot?: string;
  flush?: () => Promise<void>;
  terminate: (reason: string) => void;
  log?: ArchiveLogger;
  nowMs?: number;
}): Promise<{ archivedPath: string; archiveDir: string; sourcePath: string }> {
  await params.flush?.();
  let sourcePath = await resolveExistingTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
    agentId: params.agentId,
  });
  if (!sourcePath) {
    sourcePath = await ensureTranscriptShell({
      sessionId: params.sessionId,
      storePath: params.storePath,
      sessionFile: params.sessionFile,
      agentId: params.agentId,
    });
    if (sourcePath) {
      params.log?.warn?.(
        `session transcript missing; created shell before archive: key=${params.sessionKey} path=${sourcePath}`,
      );
    }
  }
  if (!sourcePath) {
    throw new Error(`No transcript found for session ${params.sessionKey}`);
  }
  const sessionsRoot = params.storePath ? path.dirname(params.storePath) : path.dirname(sourcePath);
  const archiveRoot = params.archiveRoot ?? path.join(sessionsRoot, "archive");
  const moved = await moveSessionToArchive({
    sessionPath: sourcePath,
    archiveRoot,
    sessionSlug: params.sessionKey,
    nowMs: params.nowMs,
  });
  params.log?.info?.(
    `session archive completed: key=${params.sessionKey} source=${sourcePath} archived=${moved.archivedPath}`,
  );
  params.terminate(USER_ARCHIVE_SHUTDOWN_REASON);
  return { archivedPath: moved.archivedPath, archiveDir: moved.archiveDir, sourcePath };
}

export async function isTranscriptEmptyShell(filePath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    return false;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return true;
  }
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { type?: string; message?: { role?: string } };
      if (
        entry?.type === "message" &&
        (entry.message?.role === "user" || entry.message?.role === "assistant")
      ) {
        return false;
      }
    } catch {
      // Malformed entries indicate non-empty/non-trivial content; do not prune.
      return false;
    }
  }
  return true;
}
