/**
 * Non-executing structural validation for manual exec secret-provider command
 * paths. Shares the exact trust rules used by startup activation so a
 * candidate configuration cannot pass schema/write validation and then fail
 * gateway cold start (see #117051).
 */
import path from "node:path";
import { inspectPathPermissions, safeStat } from "../security/audit-fs.js";
import { isPathInside } from "../security/scan-paths.js";
import { resolveUserPath } from "../utils.js";

const WINDOWS_ABS_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\[^\\]+\\[^\\]+/;

function isAbsolutePathname(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    WINDOWS_ABS_PATH_PATTERN.test(value) ||
    WINDOWS_UNC_PATH_PATTERN.test(value)
  );
}

async function readFileStatOrThrow(pathname: string, label: string) {
  const stat = await safeStat(pathname);
  if (!stat.ok) {
    throw new Error(`${label} is not readable: ${pathname}`);
  }
  if (stat.isDir) {
    throw new Error(`${label} must be a file: ${pathname}`);
  }
  return stat;
}

type ExecProviderCommandPathValidationParams = {
  command: string;
  label: string;
  trustedDirs?: string[];
};

/**
 * Validates a manual exec provider command path without executing it. Mirrors
 * the startup activation rules: absolute path, regular non-symlink file,
 * optional trusted-directory containment, non-writable-by-others permissions,
 * current-user ownership, and Windows ACL availability.
 */
export async function assertSecureExecCommandPath(
  params: ExecProviderCommandPathValidationParams,
): Promise<string> {
  const targetPath = resolveUserPath(params.command);
  if (!isAbsolutePathname(targetPath)) {
    throw new Error(`${params.label} must be an absolute path.`);
  }

  const effectivePath = targetPath;
  const stat = await readFileStatOrThrow(effectivePath, params.label);
  if (stat.isSymlink) {
    throw new Error(`${params.label} must not be a symlink: ${effectivePath}`);
  }
  // Reject non-regular files (FIFOs, sockets, device nodes). A candidate that
  // passes here is structurally what cold start will spawn; without this check
  // a special filesystem node could pass validation and fail only at spawn
  // (see ClawSweeper review on #117128).
  if (typeof stat.mode === "number" && (stat.mode & 0o170000) !== 0o100000) {
    throw new Error(`${params.label} must be a regular file: ${effectivePath}`);
  }

  if (params.trustedDirs && params.trustedDirs.length > 0) {
    const trusted = params.trustedDirs.map((entry) => resolveUserPath(entry));
    const inTrustedDir = trusted.some((dir) => isPathInside(dir, effectivePath));
    if (!inTrustedDir) {
      throw new Error(`${params.label} is outside trustedDirs: ${effectivePath}`);
    }
  }

  const perms = await inspectPathPermissions(effectivePath);
  if (!perms.ok) {
    throw new Error(`${params.label} permissions could not be verified: ${effectivePath}`);
  }
  if (perms.worldWritable || perms.groupWritable) {
    throw new Error(`${params.label} permissions are too open: ${effectivePath}`);
  }

  // Require the owner-execute bit on POSIX so a closed-permission regular file
  // cannot pass validation and fail only when cold start tries to spawn it
  // (see ClawSweeper review on #117128).
  if (process.platform !== "win32" && typeof stat.mode === "number" && (stat.mode & 0o100) === 0) {
    throw new Error(`${params.label} must be executable by its owner: ${effectivePath}`);
  }

  if (process.platform === "win32" && perms.source === "unknown") {
    throw new Error(
      `${params.label} ACL verification is unavailable on Windows for ${effectivePath}; OpenClaw fails closed when command-path permissions cannot be verified. Ensure the command file is on a local NTFS volume with inspectable ACLs (for example, confirm \`icacls\` can read the path), then retry.`,
    );
  }

  if (process.platform !== "win32" && typeof process.getuid === "function" && stat.uid != null) {
    const uid = process.getuid();
    if (stat.uid !== uid) {
      throw new Error(
        `${params.label} must be owned by the current user (uid=${uid}): ${effectivePath}`,
      );
    }
  }
  return effectivePath;
}
