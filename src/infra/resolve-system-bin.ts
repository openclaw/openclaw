import fs from "node:fs";
import path from "node:path";
import { pruneMapToMaxSize } from "./map-size.js";
import { getWindowsInstallRoots, getWindowsProgramFilesRoots } from "./windows-install-roots.js";

/** Standard trust appends local-admin/package-manager paths after strict system paths. */
type SystemBinTrust = "strict" | "standard";

// Unix directories where OS-managed or system-installed binaries live.
// User-writable or package-manager-managed directories are excluded so that
// attacker-planted binaries cannot shadow legitimate system executables.
const UNIX_BASE_TRUSTED_DIRS = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

const DARWIN_STANDARD_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
const LINUX_STANDARD_DIRS = ["/usr/local/bin"] as const;

const WIN_PATHEXT = [".exe", ".cmd", ".bat", ".com"] as const;
const WINDOWS_PROGRAM_FILES_TOOL_DIR_PREFIXES = ["ImageMagick-", "GraphicsMagick-"] as const;
const WINDOWS_PROGRAM_FILES_TOOL_DIRS = ["ImageMagick", "GraphicsMagick"] as const;

const RESOLVED_BIN_CACHE_LIMIT = 512;
const resolvedCacheStrict = new Map<string, string>();
const resolvedCacheStandard = new Map<string, string>();

function cacheResolvedSystemBin(cache: Map<string, string>, name: string, candidate: string): void {
  cache.set(name, candidate);
  pruneMapToMaxSize(cache, RESOLVED_BIN_CACHE_LIMIT);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, process.platform === "win32" ? fs.constants.R_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function collectWindowsProgramFilesToolDirs(programFilesRoot: string): string[] {
  const dirs = WINDOWS_PROGRAM_FILES_TOOL_DIRS.map((dir) => path.win32.join(programFilesRoot, dir));
  try {
    for (const entry of fs.readdirSync(programFilesRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        WINDOWS_PROGRAM_FILES_TOOL_DIR_PREFIXES.some((prefix) => entry.name.startsWith(prefix))
      ) {
        dirs.push(path.win32.join(programFilesRoot, entry.name));
      }
    }
  } catch {
    // Program Files can be unreadable in constrained contexts; static candidates still cover common installs.
  }
  return dirs;
}

/**
 * Build the trusted-dir list for Windows. Only system-managed directories
 * are included; user-profile paths like %LOCALAPPDATA% are excluded.
 */
function buildWindowsTrustedDirs(): readonly string[] {
  const dirs: string[] = [];
  const { systemRoot } = getWindowsInstallRoots();
  dirs.push(path.win32.join(systemRoot, "System32"));
  dirs.push(path.win32.join(systemRoot, "SysWOW64"));
  dirs.push(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0"));

  for (const programFilesRoot of getWindowsProgramFilesRoots()) {
    // Trust the machine's validated Program Files roots rather than assuming C:.
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL-Win64", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "OpenSSL", "bin"));
    dirs.push(path.win32.join(programFilesRoot, "ffmpeg", "bin"));
  }

  return dirs;
}

function buildWindowsStandardDirs(): readonly string[] {
  const { systemRoot } = getWindowsInstallRoots();
  const systemDriveRoot = path.win32.parse(systemRoot).root;
  const dirs = [path.win32.join(systemDriveRoot, "ProgramData", "chocolatey", "bin")];
  for (const programFilesRoot of getWindowsProgramFilesRoots()) {
    dirs.push(...collectWindowsProgramFilesToolDirs(programFilesRoot));
  }
  return dirs;
}

function buildUnixTrustedDirs(trust: SystemBinTrust): readonly string[] {
  const dirs: string[] = [...UNIX_BASE_TRUSTED_DIRS];
  const platform = process.platform;

  if (platform === "linux") {
    // Fixed NixOS system profile path. Never derive trust from NIX_PROFILES:
    // env-controlled Nix store/profile entries can be attacker-selected.
    // Callers that intentionally rely on non-default Nix paths must opt in via extraDirs.
    dirs.push("/run/current-system/sw/bin");
    dirs.push("/snap/bin");
  }

  if (trust === "standard") {
    if (platform === "darwin") {
      dirs.push(...DARWIN_STANDARD_DIRS);
    } else if (platform === "linux") {
      dirs.push(...LINUX_STANDARD_DIRS);
    }
  }

  return dirs;
}

const trustedDirs: Partial<Record<SystemBinTrust, readonly string[]>> = {};

function getTrustedDirs(trust: SystemBinTrust): readonly string[] {
  return (trustedDirs[trust] ??=
    process.platform !== "win32"
      ? buildUnixTrustedDirs(trust)
      : trust === "strict"
        ? buildWindowsTrustedDirs()
        : [...getTrustedDirs("strict"), ...buildWindowsStandardDirs()]);
}

/**
 * Resolve a binary name to an absolute path by searching only trusted system
 * directories. Returns `null` when the binary is not found. Results are cached
 * for the lifetime of the process.
 *
 * This MUST be used instead of bare binary names in `execFile`/`spawn` calls
 * for internal infrastructure binaries (ffmpeg, ffprobe, openssl, etc.) to
 * prevent PATH-hijack attacks via user-writable directories.
 */
export function resolveSystemBin(
  name: string,
  opts?: { trust?: SystemBinTrust; extraDirs?: readonly string[] },
): string | null {
  const trust = opts?.trust ?? "strict";
  const hasExtra = (opts?.extraDirs?.length ?? 0) > 0;
  const cache = trust === "standard" ? resolvedCacheStandard : resolvedCacheStrict;

  if (!hasExtra) {
    const cached = cache.get(name);
    if (cached !== undefined) {
      // Trusted-directory probes hit the filesystem repeatedly; keep active binaries ahead of
      // colder entries when the shared insertion-order pruning helper enforces the bound.
      cache.delete(name);
      cache.set(name, cached);
      return cached;
    }
  }

  const dirs = [...getTrustedDirs(trust), ...(opts?.extraDirs ?? [])];
  const isWin = process.platform === "win32";
  const hasExt = isWin && path.win32.extname(name).length > 0;

  for (const dir of dirs) {
    const candidates =
      isWin && !hasExt
        ? WIN_PATHEXT.map((ext) => path.win32.join(dir, name + ext))
        : [path.join(dir, name)];
    for (const candidate of candidates) {
      if (isExecutable(candidate)) {
        if (!hasExtra) {
          cacheResolvedSystemBin(cache, name, candidate);
        }
        return candidate;
      }
    }
  }

  return null;
}
