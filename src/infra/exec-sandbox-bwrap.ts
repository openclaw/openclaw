import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import type { AccessPolicyConfig, PermStr } from "../config/types.tools.js";
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
 * Returns null when a wildcard appears in a non-final segment (e.g. "/home/*\/.ssh/**")
 * because the truncated prefix ("/home") would be far too broad for a bwrap mount
 * and the caller must skip it entirely.
 */
function patternToPath(pattern: string, homeDir: string): string | null {
  const expanded = expandPattern(pattern, homeDir);
  // Find the first wildcard character in the path.
  const wildcardIdx = expanded.search(/[*?[]/);
  if (wildcardIdx === -1) {
    // No wildcards — the pattern is a concrete path.
    return expanded || "/";
  }
  // Check whether there is a path separator AFTER the first wildcard.
  // If so, the wildcard is in a non-final segment (e.g. /home/*/foo) and the
  // concrete prefix (/home) is too broad to be a safe mount target.
  const afterWildcard = expanded.slice(wildcardIdx);
  if (/[/\\]/.test(afterWildcard)) {
    return null;
  }
  // Wildcard is only in the final segment — use the parent directory.
  // e.g. "/var/log/secret*" → last sep before "*" is at 8 → "/var/log"
  // We must NOT use the literal prefix up to "*" (e.g. "/var/log/secret")
  // because that is not a directory and leaves suffix-glob matches uncovered.
  const lastSep = expanded.lastIndexOf("/", wildcardIdx - 1);
  const parentDir = lastSep > 0 ? expanded.slice(0, lastSep) : "/";
  return parentDir || "/";
}

function permAllowsWrite(perm: PermStr): boolean {
  return perm[1] === "w";
}

/**
 * Generate bwrap argument array for the given permissions config.
 *
 * Strategy:
 *   1. Start with --ro-bind / / (read-only view of entire host FS)
 *   2. For each rule with w bit: upgrade to --bind (read-write)
 *   3. For each deny[] entry: overlay with --tmpfs (empty, blocks reads too)
 *   4. Add /tmp and /dev as writable tmpfs mounts (required for most processes)
 *   5. When default is "---": use a more restrictive base (only bind explicit allow paths)
 */
export function generateBwrapArgs(
  config: AccessPolicyConfig,
  homeDir: string = os.homedir(),
  /**
   * Script-specific override rules to emit AFTER the deny list so they win over
   * broad deny patterns — mirrors the Seatbelt scriptOverrideRules behaviour.
   * In bwrap, later mounts win, so script grants must come last.
   */
  scriptOverrideRules?: Record<string, PermStr>,
): string[] {
  const args: string[] = [];
  const defaultPerm = config.default ?? "---";
  const defaultAllowsRead = defaultPerm[0] === "r";

  if (defaultAllowsRead) {
    // Permissive base: everything is read-only by default.
    args.push("--ro-bind", "/", "/");
    // Upgrade /tmp to writable tmpfs and overlay a real /dev for normal process operation.
    args.push("--tmpfs", "/tmp");
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

  // Apply rules: upgrade paths with w bit to read-write binds.
  // Sort by concrete path length ascending so less-specific mounts are applied
  // first — bwrap applies mounts in order, and later mounts win for overlapping
  // paths. Without sorting, a broad rw bind (e.g. ~/dev) could be emitted after
  // a narrow ro bind (~/dev/secret), wiping out the intended restriction.
  const ruleEntries = Object.entries(config.rules ?? {}).toSorted(([a], [b]) => {
    const pa = patternToPath(a, homeDir);
    const pb = patternToPath(b, homeDir);
    return (pa?.length ?? 0) - (pb?.length ?? 0);
  });
  for (const [pattern, perm] of ruleEntries) {
    const p = patternToPath(pattern, homeDir);
    if (!p || p === "/") {
      continue;
    } // root already handled above
    if (permAllowsWrite(perm)) {
      // Emit --bind-try for any rule that permits writes, including write-only ("-w-").
      // bwrap cannot enforce write-without-read at the mount level; a "-w-" rule under
      // a restrictive base will also permit reads at the OS layer. The tool layer still
      // denies read tool calls per the rule, so the practical exposure is exec-only paths.
      args.push("--bind-try", p, p);
    } else if (defaultPerm[0] !== "r" && perm[0] === "r") {
      // Restrictive base: only bind paths that the rule explicitly allows reads on.
      // Do NOT emit --ro-bind-try for "---" or "--x" rules — the base already denies
      // by not mounting; emitting a mount here would grant read access.
      args.push("--ro-bind-try", p, p);
    } else if (defaultPerm[0] === "r" && perm[0] !== "r") {
      // Permissive base + narrowing rule (no read bit): overlay with tmpfs so the
      // path is hidden even though --ro-bind / / made it readable by default.
      // This mirrors what deny[] does — without this, "---" rules under a permissive
      // default are silently ignored at the bwrap layer.
      args.push("--tmpfs", p);
    }
    // Permissive base + read-only rule: already covered by --ro-bind / /; no extra mount.
  }

  // deny[] entries: overlay with empty tmpfs — path exists but is empty.
  // tmpfs overlay hides the real contents regardless of how the path was expressed.
  for (const pattern of config.deny ?? []) {
    const p = patternToPath(pattern, homeDir);
    if (!p || p === "/") {
      continue;
    }
    args.push("--tmpfs", p);
  }

  // Script-specific override mounts — emitted after deny[] so they can reopen
  // a base-denied path for a trusted script (same precedence as Seatbelt).
  if (scriptOverrideRules) {
    const overrideEntries = Object.entries(scriptOverrideRules).toSorted(([a], [b]) => {
      const pa = patternToPath(a, homeDir);
      const pb = patternToPath(b, homeDir);
      return (pa?.length ?? 0) - (pb?.length ?? 0);
    });
    for (const [pattern, perm] of overrideEntries) {
      const p = patternToPath(pattern, homeDir);
      if (!p || p === "/") {
        continue;
      }
      if (permAllowsWrite(perm)) {
        // Any write-granting override always needs --bind-try so the path exists
        // and writes succeed. bwrap mounts are ordered; this override comes after
        // deny[] tmpfs entries, so --bind-try wins regardless of the base policy.
        args.push("--bind-try", p, p);
      } else if (perm[0] === "r") {
        args.push("--ro-bind-try", p, p);
      } else {
        args.push("--tmpfs", p);
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
  return `bwrap ${argStr} /bin/sh -c ${shellEscape(command)}`;
}
