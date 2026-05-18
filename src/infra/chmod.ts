import { accessSync, chmodSync, constants, statSync } from "node:fs";

// Best-effort chmod that tolerates EPERM/EACCES/EROFS when the path is already
// accessible.  On K8s fsGroup volumes the container user doesn't own the files,
// so chmod fails, but access is granted through group bits.
//
// Security boundary:
// - Directories: tolerate group/other read/execute (K8s fsGroup commonly
//   exposes 2775), but reject other-write (0o002).
// - Files: reject any "other" bits that exceed the requested mode. A file
//   requested as 0o600 must not stay world-readable (e.g. 0o664) — that
//   leaks private SQLite state on fsGroup volumes.
export function tryChmodSync(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch (err: unknown) {
    if (!isExpectedChmodFailure(err)) {
      throw err;
    }
    const verifyFlags =
      (mode & 0o100) !== 0
        ? constants.R_OK | constants.W_OK | constants.X_OK
        : constants.R_OK | constants.W_OK;
    try {
      accessSync(target, verifyFlags);
    } catch {
      throw err;
    }
    const stat = statSync(target);
    if (stat.isDirectory()) {
      // Directories: only reject other-write.
      if ((stat.mode & 0o002) !== 0) {
        throw err;
      }
    } else {
      // Files: reject any other bits beyond what was requested.
      const actualOther = stat.mode & 0o007;
      const requestedOther = mode & 0o007;
      if ((actualOther & ~requestedOther) !== 0) {
        throw err;
      }
    }
  }
}

function isExpectedChmodFailure(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) {
    return false;
  }
  const code = (err as { code?: string }).code;
  return code === "EPERM" || code === "EACCES" || code === "EROFS";
}
