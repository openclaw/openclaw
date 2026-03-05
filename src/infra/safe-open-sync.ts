import fs from "node:fs";
import { sameFileIdentity as hasSameFileIdentity } from "./file-identity.js";

export type SafeOpenSyncFailureReason = "path" | "validation" | "io";

export type SafeOpenSyncResult =
  | { ok: true; path: string; fd: number; stat: fs.Stats }
  | { ok: false; reason: SafeOpenSyncFailureReason; error?: unknown };

export type SafeOpenSyncAllowedType = "file" | "directory";

type SafeOpenSyncFs = Pick<
  typeof fs,
  "constants" | "lstatSync" | "realpathSync" | "openSync" | "fstatSync" | "closeSync"
>;

function isExpectedPathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function nodeErrorCode(error: unknown): string {
  if (!(typeof error === "object" && error !== null && "code" in error)) {
    return "";
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return `${code}`;
  }
  return "";
}

function isUnsupportedNoFollowError(error: unknown): boolean {
  const code = nodeErrorCode(error);
  return code === "EINVAL" || code === "ENOTSUP";
}

export function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return hasSameFileIdentity(left, right);
}

export function openVerifiedFileSync(params: {
  filePath: string;
  resolvedPath?: string;
  rejectPathSymlink?: boolean;
  rejectHardlinks?: boolean;
  maxBytes?: number;
  allowedType?: SafeOpenSyncAllowedType;
  ioFs?: SafeOpenSyncFs;
}): SafeOpenSyncResult {
  const ioFs = params.ioFs ?? fs;
  const allowedType = params.allowedType ?? "file";
  const readOnlyFlags = ioFs.constants.O_RDONLY;
  const noFollowFlag =
    typeof ioFs.constants.O_NOFOLLOW === "number" ? ioFs.constants.O_NOFOLLOW : 0;
  const openReadFlags = readOnlyFlags | noFollowFlag;
  let fd: number | null = null;
  let usedNoFollowFallback = false;
  try {
    if (params.rejectPathSymlink) {
      const candidateStat = ioFs.lstatSync(params.filePath);
      if (candidateStat.isSymbolicLink()) {
        return { ok: false, reason: "validation" };
      }
    }

    const realPath = params.resolvedPath ?? ioFs.realpathSync(params.filePath);
    const preOpenStat = ioFs.lstatSync(realPath);
    if (!isAllowedType(preOpenStat, allowedType)) {
      return { ok: false, reason: "validation" };
    }
    if (params.rejectHardlinks && preOpenStat.isFile() && preOpenStat.nlink > 1) {
      return { ok: false, reason: "validation" };
    }
    if (
      params.maxBytes !== undefined &&
      preOpenStat.isFile() &&
      preOpenStat.size > params.maxBytes
    ) {
      return { ok: false, reason: "validation" };
    }

    try {
      fd = ioFs.openSync(realPath, openReadFlags);
    } catch (error) {
      // Some environments expose O_NOFOLLOW but reject it at runtime.
      if (noFollowFlag !== 0 && isUnsupportedNoFollowError(error)) {
        usedNoFollowFallback = true;
        fd = ioFs.openSync(realPath, readOnlyFlags);
      } else {
        throw error;
      }
    }
    const openedStat = ioFs.fstatSync(fd);
    if (!isAllowedType(openedStat, allowedType)) {
      return { ok: false, reason: "validation" };
    }
    if (params.rejectHardlinks && openedStat.isFile() && openedStat.nlink > 1) {
      return { ok: false, reason: "validation" };
    }
    if (params.maxBytes !== undefined && openedStat.isFile() && openedStat.size > params.maxBytes) {
      return { ok: false, reason: "validation" };
    }
    if (usedNoFollowFallback) {
      // Without O_NOFOLLOW support, re-check that the opened path node still
      // matches the expected type and resolves to the same inode/device as fd.
      // This closes the obvious rename+symlink race on the fallback path.
      const postOpenPathStat = ioFs.lstatSync(realPath);
      if (!isAllowedType(postOpenPathStat, allowedType)) {
        return { ok: false, reason: "validation" };
      }
      if (params.rejectHardlinks && postOpenPathStat.isFile() && postOpenPathStat.nlink > 1) {
        return { ok: false, reason: "validation" };
      }
      if (!sameFileIdentity(postOpenPathStat, openedStat)) {
        return { ok: false, reason: "validation" };
      }
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
      ioFs.closeSync(fd);
    }
  }
}

function isAllowedType(stat: fs.Stats, allowedType: SafeOpenSyncAllowedType): boolean {
  if (allowedType === "directory") {
    return stat.isDirectory();
  }
  return stat.isFile();
}
