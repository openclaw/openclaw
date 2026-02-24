import fs from "node:fs";

export type SafeOpenSyncFailureReason = "path" | "validation" | "io";

export type SafeOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats }
  | { ok: false; reason: SafeOpenSyncFailureReason; error?: unknown };

const OPEN_READ_FLAGS =
  fs.constants.O_RDONLY |
  (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0);

function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  // On Windows, lstatSync (by path) may return dev=0 while fstatSync (by fd)
  // returns the real volume serial number.  When either dev is 0, fall back to
  // ino-only comparison which is still unique within a single volume.
  const devMatch =
    left.dev === right.dev || (process.platform === "win32" && (left.dev === 0 || right.dev === 0));
  return devMatch && left.ino === right.ino;
}

export function openVerifiedFileSync(params: {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  maxBytes?: number;
}): SafeOpenSyncResult {
  let fd: number | null = null;
  try {
    if (params.rejectPathSymlink) {
      const candidateStat = fs.lstatSync(params.filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = params.resolvedPath ?? fs.realpathSync(params.filePath);
    const preOpenStat = fs.lstatSync(realPath);
    if (!preOpenStat.isFile()) {
      return { ok: false, reason: "validation" };
    }
    if (params.maxBytes !== undefined && preOpenStat.size > params.maxBytes) {
      return { ok: false, reason: "validation" };
    }

    fd = fs.openSync(realPath, OPEN_READ_FLAGS);
    const openedStat = fs.fstatSync(fd);
    if (!openedStat.isFile()) {
      return { ok: false, reason: "validation" };
    }
    if (params.maxBytes !== undefined && openedStat.size > params.maxBytes) {
      return { ok: false, reason: "validation" };
    }
    if (!sameFileIdentity(preOpenStat, openedStat)) {
      return { ok: false, reason: "validation" };
    }

    const opened = { ok: true as const, path: realPath, fd, stat: openedStat };
    fd = null;
    return opened;
  } catch (error) {
    if (isExpectedPathError(error)) {
      return { ok: false, reason: "path", error };
    }
    return { ok: false, reason: "io", error };
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}
