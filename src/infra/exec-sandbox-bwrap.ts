import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { promisify } from "node:util";
import type { AccessPolicyConfig, PermStr } from "../config/types.tools.js";
import { findBestRule } from "./access-policy.js";
import { shellEscape } from "./shell-escape.js";

const execFileAsync = promisify(execFile);

/**
 * bwrap (bubblewrap) profile generator for Linux.
 *
 * Translates tools.fs.permissions into a mount-namespace spec so that exec
 * commands see only the filesystem view defined by the policy. Denied paths
 * are overlaid with an empty tmpfs — they appear to exist but contain nothing,
 * preventing reads of sensitive files even when paths are expressed via
 * variable expansion (cat $HOME/.ssh/id_rsa, etc.).
 *
 * Note: bwrap is not installed by default on all distributions. Use
 * isBwrapAvailable() to check before calling generateBwrapArgs().
 */

// Standard system paths to bind read-only so wrapped commands can run.
// These are read-only unless the user's rules grant write access.
const SYSTEM_RO_BIND_PATHS = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc", "/opt"] as const;

let bwrapAvailableCache: boolean | undefined;

// Warn once per process when a file-specific "---" rule cannot be enforced at
// the OS layer (bwrap --tmpfs only accepts directories). Tool-layer enforcement
// still applies for read/write/edit tool calls, but exec commands that access
// the file directly inside the sandbox are not blocked at the syscall level.
const _bwrapFileDenyWarnedPaths = new Set<string>();
/** Reset the one-time file-deny warning set. Only for use in tests. */
export function _resetBwrapFileDenyWarnedPathsForTest(): void {
  _bwrapFileDenyWarnedPaths.clear();
}
/** Reset the bwrap availability cache. Only for use in tests. */
export function _resetBwrapAvailableCacheForTest(): void {
  bwrapAvailableCache = undefined;
}
export function _warnBwrapFileDenyOnce(filePath: string): void {
  if (_bwrapFileDenyWarnedPaths.has(filePath)) {
    return;
  }
  _bwrapFileDenyWarnedPaths.add(filePath);
  console.error(
    `[access-policy] bwrap: "---" rule for "${filePath}" resolves to a file — ` +
      `OS-level (bwrap) enforcement is not applied. ` +
      `Tool-layer enforcement still blocks read/write/edit tool calls. ` +
      `To protect this file at the OS layer on Linux, use a "---" rule on its parent directory instead.`,
  );
}

/**
 * Returns true if bwrap is installed and executable on this system.
 * Result is cached after the first call.
 */
export async function isBwrapAvailable(): Promise<boolean> {
  if (bwrapAvailableCache !== undefined) {
    return bwrapAvailableCache;
  }
  try {
    await execFileAsync("bwrap", ["--version"]);
    bwrapAvailableCache = true;
  } catch {
    bwrapAvailableCache = false;
  }
  return bwrapAvailableCache;
}

/** Expand a leading ~ and trailing-slash shorthand (mirrors access-policy.ts expandPattern). */
function expandPattern(pattern: string, homeDir: string): string {
  // Trailing / shorthand: "/tmp/" → "/tmp/**" so sort-order length matches a
  // "/tmp/**" rule and patternToPath strips it to "/tmp" correctly.
  const normalized = pattern.endsWith("/") ? pattern + "**" : pattern;
  if (!normalized.startsWith("~")) {
    return normalized;
  }
  return normalized.replace(/^~(?=$|[/\\])/, homeDir);
}

/**
 * Strip trailing wildcard segments to get the longest concrete path prefix.
 * e.g. "/Users/kaveri/**" → "/Users/kaveri"
 *      "/tmp/foo"         → "/tmp/foo"
 *
 * For mid-path wildcards (e.g. "skills/**\/*.sh"), returns the concrete prefix
 * when perm is not "---" — the prefix is an intentional approximation for bwrap
 * mounts; the tool layer enforces the file-type filter precisely. For "---" perms
 * returns null so callers skip emission (a deny-all on the prefix would be too broad).
 */
function patternToPath(pattern: string, homeDir: string, perm?: PermStr): string | null {
  const expanded = expandPattern(pattern, homeDir);
  // Find the first wildcard character in the path.
  const wildcardIdx = expanded.search(/[*?[]/);
  if (wildcardIdx === -1) {
    // No wildcards — the pattern is a concrete path.
    return expanded || "/";
  }
  // Check whether there is a path separator AFTER the first wildcard.
  // If so, the wildcard is in a non-final segment (e.g. skills/**/*.sh).
  const afterWildcard = expanded.slice(wildcardIdx);
  if (/[/\\]/.test(afterWildcard)) {
    // Mid-path wildcard: for "---" perm a deny-all on the prefix is too broad — skip.
    // For other perms, use the prefix as an approximate mount target; the tool layer
    // enforces the file-type filter precisely.
    if (!perm || perm === "---") {
      return null;
    }
    // Fall through to use the concrete prefix below.
  }
  // Wildcard is only in the final segment — use the parent directory.
  // e.g. "/var/log/secret*" → last sep before "*" is at 8 → "/var/log"
  // We must NOT use the literal prefix up to "*" (e.g. "/var/log/secret")
  // because that is not a directory and leaves suffix-glob matches uncovered.
  const lastSep = expanded.lastIndexOf("/", wildcardIdx - 1);
  const parentDir = lastSep > 0 ? expanded.slice(0, lastSep) : "/";
  return parentDir || "/";
}

// Keep in sync with VALID_PERM_RE in access-policy.ts and exec-sandbox-seatbelt.ts.
const VALID_PERM_RE = /^[r-][w-][x-]$/;

function permAllowsWrite(perm: PermStr): boolean {
  return VALID_PERM_RE.test(perm) && perm[1] === "w";
}

/**
 * Generate bwrap argument array for the given permissions config.
 *
 * Strategy:
 *   1. Check the "/**" rule to determine permissive vs restrictive base.
 *   2. Permissive base (r in "/**"): --ro-bind / / (read-only view of entire host FS).
 *   3. Restrictive base (no r in "/**"): only bind system paths needed to run processes.
 *   4. For each rule with w bit: upgrade to --bind (read-write).
 *   5. For each "---" rule in permissive mode: overlay with --tmpfs to hide the path.
 *   6. Add /tmp and /dev as writable tmpfs mounts (required for most processes).
 */
export function generateBwrapArgs(
  config: AccessPolicyConfig,
  homeDir: string = os.homedir(),
  /**
   * Script-specific override rules to emit AFTER the base rules so they win over
   * broader patterns — mirrors the Seatbelt scriptOverrideRules behaviour.
   * In bwrap, later mounts win, so script grants must come last.
   */
  scriptOverrideRules?: Record<string, PermStr>,
): string[] {
  const args: string[] = [];
  // Determine base stance from the "/**" catch-all rule (replaces the removed `default` field).
  const rawCatchAllPerm = findBestRule("/**", config.policy ?? {}, homeDir) ?? "---";
  // Validate format before positional access — malformed perm falls back to "---" (fail closed).
  const catchAllPerm = VALID_PERM_RE.test(rawCatchAllPerm) ? rawCatchAllPerm : "---";
  const defaultAllowsRead = catchAllPerm[0] === "r";

  if (defaultAllowsRead) {
    // Permissive base: everything is read-only by default.
    args.push("--ro-bind", "/", "/");
    // --ro-bind / / is a recursive bind but does NOT propagate special kernel
    // filesystems (procfs, devtmpfs) into the new mount namespace. Explicitly
    // mount /proc so programs that read /proc/self/*, /proc/cpuinfo, etc. work
    // correctly inside the sandbox (shells, Python, most build tools need this).
    args.push("--proc", "/proc");
    args.push("--dev", "/dev");
  } else {
    // Restrictive base: only bind system paths needed to run processes.
    for (const p of SYSTEM_RO_BIND_PATHS) {
      args.push("--ro-bind-try", p, p);
    }
    // proc and dev are needed for most processes.
    args.push("--proc", "/proc");
    args.push("--dev", "/dev");
    // /tmp is intentionally NOT mounted here — a restrictive policy (default:"---")
    // should not grant free write access to /tmp. Add a rule "/tmp/**": "rw-" if
    // the enclosed process genuinely needs it.
  }

  // Writable /tmp tmpfs — only in permissive mode AND only when the policy does not
  // explicitly restrict writes on /tmp. Keeping this outside the if/else block above
  // makes the defaultAllowsRead guard self-evident and not implicit from nesting.
  // In restrictive mode (default:"---"), /tmp is intentionally omitted so rules
  // control tmpfs access explicitly (e.g. "/tmp/**":"rwx" is handled by the rules loop).
  if (defaultAllowsRead) {
    const explicitTmpPerm = findBestRule("/tmp", config.policy ?? {}, homeDir);
    if (explicitTmpPerm === null) {
      // Only emit --tmpfs /tmp when there is no explicit rule for /tmp.
      // When an explicit write rule exists, the rules loop below emits --bind-try /tmp /tmp
      // which (as a later mount) wins over --tmpfs anyway — emitting --tmpfs here too
      // is dead code. When an explicit read-only rule exists, /tmp is already readable
      // via --ro-bind / / and no extra mount is needed.
      args.push("--tmpfs", "/tmp");
    }
  }

  // Apply rules: upgrade paths with w bit to read-write binds.
  // Sort by concrete path length ascending so less-specific mounts are applied
  // first — bwrap applies mounts in order, and later mounts win for overlapping
  // paths. Without sorting, a broad rw bind (e.g. ~/dev) could be emitted after
  // a narrow ro bind (~/dev/secret), wiping out the intended restriction.
  const ruleEntries = Object.entries(config.policy ?? {}).toSorted(([a], [b]) => {
    const pa = patternToPath(a, homeDir);
    const pb = patternToPath(b, homeDir);
    return (pa?.length ?? 0) - (pb?.length ?? 0);
  });
  for (const [pattern, perm] of ruleEntries) {
    const p = patternToPath(pattern, homeDir, perm);
    if (!p || p === "/") {
      continue;
    } // root already handled above
    if (permAllowsWrite(perm)) {
      // Emit --bind-try for any rule that permits writes, including write-only ("-w-").
      // bwrap cannot enforce write-without-read at the mount level; a "-w-" rule under
      // a restrictive base will also permit reads at the OS layer. The tool layer still
      // denies read tool calls per the rule, so the practical exposure is exec-only paths.
      args.push("--bind-try", p, p);
    } else if (VALID_PERM_RE.test(perm) && catchAllPerm[0] !== "r" && perm[0] === "r") {
      // Restrictive base: only bind paths that the rule explicitly allows reads on.
      // Do NOT emit --ro-bind-try for "---" or "--x" rules — the base already denies
      // by not mounting; emitting a mount here would grant read access.
      // VALID_PERM_RE guard: malformed perm falls through to no-op (fail closed).
      args.push("--ro-bind-try", p, p);
    } else if (VALID_PERM_RE.test(perm) && perm[0] !== "r") {
      // Deny/exec-only rule: overlay with --tmpfs to hide the path.
      // Two cases handled identically:
      //   Permissive base (catchAllPerm[0] === "r"): --ro-bind / / made path readable;
      //     --tmpfs hides it.
      //   Restrictive base (catchAllPerm[0] !== "r"): SYSTEM_RO_BIND_PATHS unconditionally
      //     mounts /etc, /usr, /bin, /lib, /lib64, /sbin, /opt; a "---" rule on those paths
      //     had no effect without this branch because the three prior branches all require
      //     perm[0] === "r". For non-system paths in restrictive mode, --tmpfs is a no-op
      //     (nothing mounted there to overlay), so emitting it is harmless.
      // Guard: bwrap --tmpfs only accepts a directory as the mount point. If the
      // resolved path is a file, skip the mount and warn — same behaviour as deny[].
      // Non-existent paths are assumed to be directories (forward-protection).
      let isDir = true;
      try {
        isDir = fs.statSync(p).isDirectory();
      } catch {
        // Non-existent — assume directory.
      }
      if (isDir) {
        args.push("--tmpfs", p);
      } else {
        _warnBwrapFileDenyOnce(p);
      }
    }
    // Permissive base + read-only rule: already covered by --ro-bind / /; no extra mount.
    // Restrictive base + read-only rule: emitted as --ro-bind-try above.
  }

  // Script-specific override mounts — emitted after base rules so they can reopen
  // a base-denied path for a trusted script (same precedence as Seatbelt).
  if (scriptOverrideRules) {
    const overrideEntries = Object.entries(scriptOverrideRules).toSorted(([a], [b]) => {
      const pa = patternToPath(a, homeDir);
      const pb = patternToPath(b, homeDir);
      return (pa?.length ?? 0) - (pb?.length ?? 0);
    });
    for (const [pattern, perm] of overrideEntries) {
      const p = patternToPath(pattern, homeDir, perm);
      if (!p || p === "/") {
        continue;
      }
      if (permAllowsWrite(perm)) {
        // Any write-granting override always needs --bind-try so the path exists
        // and writes succeed. bwrap mounts are ordered; this override comes after
        // deny[] tmpfs entries, so --bind-try wins regardless of the base policy.
        args.push("--bind-try", p, p);
      } else if (VALID_PERM_RE.test(perm) && perm[0] === "r") {
        // VALID_PERM_RE guard: malformed perm falls through to the deny branch below.
        args.push("--ro-bind-try", p, p);
      } else {
        // Mirror the base-rules isDir guard — bwrap --tmpfs only accepts directories.
        let isDir = true;
        try {
          isDir = fs.statSync(p).isDirectory();
        } catch {
          // Non-existent — assume directory (forward-protection).
        }
        if (isDir) {
          args.push("--tmpfs", p);
        } else {
          _warnBwrapFileDenyOnce(p);
        }
      }
    }
  }

  // Separator before the command.
  args.push("--");

  return args;
}

/**
 * Wrap a shell command with bwrap using the given permissions config.
 * Returns the wrapped command string ready to pass as execCommand.
 */
export function wrapCommandWithBwrap(
  command: string,
  config: AccessPolicyConfig,
  homeDir: string = os.homedir(),
  scriptOverrideRules?: Record<string, PermStr>,
): string {
  const bwrapArgs = generateBwrapArgs(config, homeDir, scriptOverrideRules);
  const argStr = bwrapArgs.map((a) => (a === "--" ? "--" : shellEscape(a))).join(" ");
  // /bin/sh is intentional: sandboxed commands must use a shell whose path is
  // within the bwrap mount namespace. The user's configured shell (getShellConfig)
  // may live outside the mounted paths (e.g. /opt/homebrew/bin/fish) and would
  // not be reachable inside the sandbox. /bin/sh is always available via
  // SYSTEM_RO_BIND_PATHS or the permissive --ro-bind / / base mount.
  return `bwrap ${argStr} /bin/sh -c ${shellEscape(command)}`;
}
