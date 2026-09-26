// Shared source inspection for Doctor import and startup migration readiness only.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { tryResolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveStoredSessionOwnerAgentId } from "../../gateway/session-store-key.js";
import { readFileDescriptorBoundedSync } from "../../infra/boundary-file-read.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { tryResolveLegacyCompatibilityAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { isPrimarySessionTranscriptFileName } from "./artifacts.js";
import { parseSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveSessionFilePathCore } from "./paths.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import type { SessionEntry } from "./types.js";

export type LegacySessionStoreTarget = { agentId: string; storePath: string; sqlitePath?: string };
type LegacySessionStoreIssue = { code: string; message: string; sessionKey?: string };

export function listLegacySessionTranscriptFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isFile() && isPrimarySessionTranscriptFileName(item.name))
    .map((item) => path.join(directory, item.name));
}

export function readLegacySessionStoreEntries(
  target: Pick<LegacySessionStoreTarget, "storePath">,
  issues: LegacySessionStoreIssue[],
  options: { allowMissingStore?: boolean; sourcePath?: string } = {},
): { entries: Array<{ sessionKey: string; entry: SessionEntry }>; bytes?: Buffer } {
  // Open a file descriptor first, then stat and read through it to eliminate
  // the TOCTOU race where a file can change between size validation and read.
  // Use O_NONBLOCK so a path substituted with a FIFO cannot block waiting for
  // a writer; fstat on the descriptor then rejects non-regular files.
  const openFlags =
    process.platform === "win32" ? "r" : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  let fd: number;
  try {
    fd = fs.openSync(options.sourcePath ?? target.storePath, openFlags);
  } catch (err) {
    if (options.allowMissingStore === true && hasErrnoCode(err, "ENOENT")) {
      try {
        const parentStat = fs.statSync(path.dirname(target.storePath));
        if (!parentStat.isDirectory()) {
          issues.push({
            code: "store_unreadable",
            message: `${target.storePath}: parent path is not a directory`,
          });
        }
      } catch (parentErr) {
        if (!hasErrnoCode(parentErr, "ENOENT")) {
          issues.push({
            code: "store_unreadable",
            message: `${target.storePath}: ${String(parentErr)}`,
          });
        }
      }
      return { entries: [] };
    }
    issues.push({
      code: "store_unreadable",
      message: `${target.storePath}: ${String(err)}`,
    });
    return { entries: [] };
  }

  try {
    let parsed: unknown;
    let raw: Buffer;
    try {
      const storeStat = fs.fstatSync(fd);
      if (!storeStat.isFile()) {
        issues.push({
          code: "store_unreadable",
          message: `${target.storePath}: not a regular file`,
        });
        return { entries: [] };
      }
      // Fail closed if the pinned file grows past the size validated above.
      raw = readFileDescriptorBoundedSync(fd, storeStat.size);
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch (err) {
      issues.push({
        code: "store_unreadable",
        message: `${target.storePath}: ${String(err)}`,
      });
      return { entries: [] };
    }
    if (!isRecord(parsed)) {
      issues.push({
        code: "store_not_object",
        message: `${target.storePath} does not contain an object session store.`,
      });
      return { entries: [] };
    }
    const entries: Array<{ sessionKey: string; entry: SessionEntry }> = [];
    for (const [sessionKey, value] of Object.entries(parsed)) {
      if (!isSessionEntry(value)) {
        issues.push({
          code: "entry_invalid",
          message: `${target.storePath}: session entry is missing a valid sessionId; skipped while preserving the original index for recovery.`,
          sessionKey,
        });
        continue;
      }
      entries.push({ entry: value, sessionKey });
    }
    return { entries, bytes: raw };
  } finally {
    fs.closeSync(fd);
  }
}

export function isLegacySessionRecordOwnedByTarget(
  cfg: OpenClawConfig,
  target: LegacySessionStoreTarget,
  sessionKey: string,
): boolean {
  if (target.sqlitePath) {
    const parsed = parseAgentSessionKey(sessionKey);
    const ownerAgentId =
      parsed?.agentId ??
      cfg.agents?.defaults?.sessionStore?.agentId?.trim() ??
      tryResolveLegacyCompatibilityAgentId(cfg);
    return ownerAgentId
      ? normalizeAgentId(ownerAgentId) === normalizeAgentId(target.agentId)
      : false;
  }
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg,
    agentId: target.agentId,
    sessionKey,
  });
  return ownerAgentId
    ? ownerAgentId === target.agentId
    : target.agentId === tryResolveDefaultAgentId(cfg);
}

export function shouldFilterLegacySessionRecordsByTarget(
  target: LegacySessionStoreTarget,
): boolean {
  // Filtering depends on whether the authored store path encodes an owner,
  // not on the configured/default owner selected for its SQLite target.
  return !resolveUnsuffixedSqliteTargetFromSessionStorePath(target.storePath).agentId;
}

export function resolveLegacyTranscriptPaths(
  target: Pick<LegacySessionStoreTarget, "agentId" | "storePath">,
  entry: { sessionId: string; sessionFile?: unknown },
  verifiedSourcePaths?: ReadonlySet<string>,
): {
  transcriptPath?: string;
  transcriptCandidates: string[];
  transcriptDependencies: string[];
} {
  const legacySessionFile = typeof entry.sessionFile === "string" ? entry.sessionFile : undefined;
  if (parseSqliteSessionFileMarker(legacySessionFile)) {
    return { transcriptCandidates: [], transcriptDependencies: [] };
  }
  const sessionsDir = path.dirname(target.storePath);
  const relocatedPath = legacySessionFile?.trim()
    ? path.join(sessionsDir, path.basename(legacySessionFile))
    : undefined;
  let defaultPath: string;
  try {
    defaultPath = resolveSessionFilePathCore(entry.sessionId, entry, {
      agentId: target.agentId,
      sessionsDir,
    });
  } catch (error) {
    if (!relocatedPath) {
      throw error;
    }
    defaultPath = relocatedPath;
  }
  const transcriptPaths = relocatedPath ? [defaultPath, relocatedPath] : [defaultPath];
  const transcriptPath =
    transcriptPaths.find((file) => verifiedSourcePaths?.has(path.resolve(file))) ??
    transcriptPaths.find((file) => fs.existsSync(file)) ??
    (relocatedPath ? defaultPath : undefined);
  // Reads may retain a foreign root after archival, but recovery artifacts are direct
  // files in this target's sessions directory. Their dependencies must stay local too.
  const transcriptDependencies = transcriptPaths.map((file) =>
    path.join(sessionsDir, path.basename(file)),
  );
  return { transcriptPath, transcriptCandidates: transcriptPaths, transcriptDependencies };
}

function isSessionEntry(value: unknown): value is SessionEntry {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.trim() !== "";
}
