// Applies private POSIX modes without rejecting filesystems that cannot enforce chmod.
import { randomUUID } from "node:crypto";
import { chmodSync, fchmodSync, fstatSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isErrno } from "./errno.js";

const CHMOD_UNSUPPORTED_CODES = new Set(["ENOTSUP", "EOPNOTSUPP", "EINVAL"]);
const PRIVATE_PROBE_FILE_MODE = 0o600;

function hasRestrictivePermissions(target: string): boolean {
  try {
    return (statSync(target).mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function filesystemRejectsChmod(target: string): boolean {
  let probePath: string;
  try {
    const probeDir = statSync(target).isDirectory() ? target : path.dirname(target);
    probePath = path.join(probeDir, `.openclaw-chmod-probe-${randomUUID()}`);
    writeFileSync(probePath, "", { flag: "wx", mode: PRIVATE_PROBE_FILE_MODE });
  } catch {
    return false;
  }
  try {
    chmodSync(probePath, PRIVATE_PROBE_FILE_MODE);
    return false;
  } catch (err) {
    return isErrno(err) && err.code === "EPERM";
  } finally {
    try {
      unlinkSync(probePath);
    } catch {
      // The probe is best-effort cleanup after a failed capability check.
    }
  }
}

function canIgnorePrivateChmodError(
  target: string,
  code: string | undefined,
  restrictive: boolean,
): boolean {
  if (code && CHMOD_UNSUPPORTED_CODES.has(code)) {
    return true;
  }
  if (code !== "EROFS" && code !== "EPERM") {
    return false;
  }
  // WSL's EROFS only admits already-private paths. Ambiguous EPERM can also
  // admit a broad path when its filesystem demonstrably rejects chmod.
  return restrictive || (code === "EPERM" && filesystemRejectsChmod(target));
}

/**
 * Applies a private POSIX mode, reporting unsupported filesystems without
 * weakening real permission failures.
 */
export function applyPrivateModeSync(
  target: string,
  mode: number,
): { applied: true } | { applied: false; error: unknown } {
  // A same-mode chmod can change ctime and invalidate read-only inspection evidence.
  if ((statSync(target).mode & 0o7777) === mode) {
    return { applied: true };
  }
  try {
    chmodSync(target, mode);
    return { applied: true };
  } catch (err) {
    if (
      !canIgnorePrivateChmodError(
        target,
        isErrno(err) ? err.code : undefined,
        hasRestrictivePermissions(target),
      )
    ) {
      throw err;
    }
    return { applied: false, error: err };
  }
}

/**
 * Applies a private POSIX mode to an already-admitted descriptor.
 *
 * A pathname chmod re-resolves every component, so an alias introduced above or
 * at the target between admission and mutation would receive the mode instead.
 * Binding the change to the open descriptor keeps it on the object the caller
 * verified. The pathname is still used to probe filesystem chmod support, which
 * writes a throwaway probe beside the target rather than touching it.
 */
export function applyPrivateModeToFdSync(
  fd: number,
  target: string,
  mode: number,
): { applied: true } | { applied: false; error: unknown } {
  // A same-mode chmod can change ctime and invalidate read-only inspection evidence.
  if ((fstatSync(fd).mode & 0o7777) === mode) {
    return { applied: true };
  }
  try {
    fchmodSync(fd, mode);
    return { applied: true };
  } catch (err) {
    if (
      !canIgnorePrivateChmodError(
        target,
        isErrno(err) ? err.code : undefined,
        (fstatSync(fd).mode & 0o077) === 0,
      )
    ) {
      throw err;
    }
    return { applied: false, error: err };
  }
}
