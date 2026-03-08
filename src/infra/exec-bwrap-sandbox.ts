/**
 * Bubblewrap (bwrap) namespace sandbox for safeBins exec commands.
 *
 * Wraps commands in an unprivileged user namespace where only approved
 * binaries, system libraries, and the working directory are visible.
 * Trust windows bypass this entirely.
 *
 * Requirements:
 * - Linux (user namespaces must be enabled)
 * - bubblewrap (`bwrap`) installed (ships with Fedora/Ubuntu via Flatpak deps)
 */

import { execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Types ──────────────────────────────────────────────────────────

export type BwrapSandboxMode = "none" | "bwrap";

export interface BwrapExtraBind {
  /** Source path on the host. */
  src: string;
  /** Destination path inside the sandbox (defaults to src). */
  dest?: string;
  /** Mount read-write (default: false = read-only). */
  writable?: boolean;
}

export interface BuildBwrapArgsParams {
  /** Set of approved safe-bin names (e.g. "curl", "jq"). */
  safeBins: ReadonlySet<string>;
  /** Directories to search for safe-bin binaries. */
  trustedSafeBinDirs: ReadonlySet<string>;
  /** Working directory (mounted read-write). */
  workdir: string;
  /** Additional bind mounts. */
  extraBinds?: readonly BwrapExtraBind[];
  /** Extra shell binaries to mount (e.g. from getShellConfig). */
  extraShellBinaries?: readonly string[];
}

// ── Constants ──────────────────────────────────────────────────────

/** Shell binaries that are always mounted (required for `sh -c`). */
const SHELL_BINARIES = ["sh", "bash", "env"];

/** System library paths mounted read-only for dynamic linking. */
const SYSTEM_LIB_PATHS = ["/lib", "/lib64", "/usr/lib", "/usr/lib64"];

/** System config paths mounted read-only (SSL, DNS, locale, etc). */
const SYSTEM_CONFIG_PATHS = [
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/passwd",
  "/etc/group",
  "/etc/localtime",
  "/etc/alternatives",
];

// ── Bwrap Detection (cached after first probe) ───────────────────

let _bwrapPath: string | false | undefined;

/**
 * Check if bwrap is available (sync, cached).
 * First call may block briefly; subsequent calls return immediately.
 */
export function isBwrapAvailable(): boolean {
  if (_bwrapPath !== undefined) {
    return _bwrapPath !== false;
  }
  try {
    const result = execFileSync("which", ["bwrap"], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    _bwrapPath = result || false;
  } catch {
    _bwrapPath = false;
  }
  return _bwrapPath !== false;
}

/**
 * Async variant of isBwrapAvailable — prefer this in hot paths
 * to avoid blocking the event loop on first probe.
 */
export function isBwrapAvailableAsync(): Promise<boolean> {
  if (_bwrapPath !== undefined) {
    return Promise.resolve(_bwrapPath !== false);
  }
  return new Promise((resolve) => {
    execFile("which", ["bwrap"], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout?.trim()) {
        _bwrapPath = false;
        resolve(false);
      } else {
        _bwrapPath = stdout.trim();
        resolve(true);
      }
    });
  });
}

export function getBwrapPath(): string {
  if (typeof _bwrapPath === "string") {
    return _bwrapPath;
  }
  return "/usr/bin/bwrap";
}

/** Reset cached bwrap detection (for testing). */
export function resetBwrapCache(): void {
  _bwrapPath = undefined;
}

// ── Config Normalization ──────────────────────────────────────────

export function normalizeBwrapSandboxMode(value: unknown): BwrapSandboxMode {
  if (typeof value === "string" && value.trim().toLowerCase() === "bwrap") {
    return "bwrap";
  }
  return "none";
}

export function normalizeBwrapExtraBinds(value: unknown): BwrapExtraBind[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is Record<string, unknown> =>
        entry != null &&
        typeof entry === "object" &&
        typeof (entry as Record<string, unknown>).src === "string" &&
        ((entry as Record<string, unknown>).src as string).length > 0,
    )
    .map((entry) => ({
      src: entry.src as string,
      dest: typeof entry.dest === "string" ? entry.dest : undefined,
      writable: entry.writable === true,
    }));
}

// ── Core: Build bwrap Arguments ───────────────────────────────────

/**
 * Build the argv prefix for a bwrap-sandboxed command.
 *
 * Returns an array like:
 *   ["bwrap", "--unshare-all", "--share-net", ...]
 *
 * The caller appends the separator and the actual command:
 *   [...buildBwrapArgs(params), "--", "sh", "-c", command]
 */
export function buildBwrapArgs(params: BuildBwrapArgsParams): string[] {
  const args: string[] = [getBwrapPath()];
  const workdir = path.resolve(params.workdir);
  const mounted = new Set<string>();

  // Helper: add a bind mount, deduplicating by destination
  const addBind = (src: string, dest: string, writable: boolean) => {
    if (mounted.has(dest)) {
      return;
    }
    mounted.add(dest);
    args.push(writable ? "--bind" : "--ro-bind", src, dest);
  };

  // ── Namespace isolation ──
  args.push("--unshare-all", "--share-net", "--die-with-parent");

  // ── Pseudo-filesystems ──
  args.push("--proc", "/proc");
  args.push("--dev", "/dev");
  args.push("--tmpfs", "/tmp");

  // ── Shell binaries (always needed for sh -c execution) ──
  // Mount defaults plus any extra shells from getShellConfig()
  const allShells = new Set(SHELL_BINARIES);
  if (params.extraShellBinaries) {
    for (const s of params.extraShellBinaries) {
      allShells.add(s);
    }
  }
  for (const name of allShells) {
    const resolved = resolveInDirs(name, params.trustedSafeBinDirs);
    if (resolved) {
      addBind(resolved, resolved, false);
    }
  }

  // ── SafeBins binaries ──
  for (const name of params.safeBins) {
    const resolved = resolveInDirs(name, params.trustedSafeBinDirs);
    if (resolved) {
      addBind(resolved, resolved, false);
    }
  }

  // ── System libraries (dynamic linker, shared objects) ──
  for (const libPath of SYSTEM_LIB_PATHS) {
    if (fs.existsSync(libPath)) {
      addBind(libPath, libPath, false);
    }
  }

  // ── System config (SSL certs, DNS, locale) ──
  for (const cfgPath of SYSTEM_CONFIG_PATHS) {
    if (fs.existsSync(cfgPath)) {
      addBind(cfgPath, cfgPath, false);
    }
  }

  // ── Working directory (read-write) ──
  addBind(workdir, workdir, true);

  // ── Extra user-specified binds ──
  if (params.extraBinds) {
    for (const bind of params.extraBinds) {
      const dest = bind.dest || bind.src;
      addBind(bind.src, dest, bind.writable ?? false);
    }
  }

  return args;
}

// ── Helpers ───────────────────────────────────────────────────────

/** Resolve a binary name in trusted directories. Returns absolute path or null. */
function resolveInDirs(name: string, dirs: ReadonlySet<string>): string | null {
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) {
        return candidate;
      }
    } catch {
      // Not found in this dir, continue
    }
  }
  return null;
}
