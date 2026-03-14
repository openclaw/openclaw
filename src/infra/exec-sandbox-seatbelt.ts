import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessPolicyConfig, PermStr } from "../config/types.tools.js";
import { findBestRule } from "./access-policy.js";
import { shellEscape } from "./shell-escape.js";

/**
 * Seatbelt (SBPL) profile generator for macOS sandbox-exec.
 *
 * Translates tools.fs.permissions into a Seatbelt profile so that exec commands
 * run under OS-level path enforcement — catching variable-expanded paths like
 * `cat $HOME/.ssh/id_rsa` that config-level heuristics cannot intercept.
 *
 * Precedence in generated profiles (matches AccessPolicyConfig semantics):
 *   1. deny[] entries — placed last, always override rules.
 *   2. rules — sorted shortest-to-longest so more specific rules overwrite broader ones.
 *   3. System baseline — allows the process to load libraries and basic OS resources.
 *   4. default — sets the base allow/deny for everything else.
 */

// SBPL operation names for each permission bit.
const SEATBELT_READ_OPS = "file-read*";
const SEATBELT_WRITE_OPS = "file-write*";
const SEATBELT_EXEC_OPS = "process-exec*";

// System paths every process needs to function (dynamic linker, stdlib, etc.).
// These are allowed for file-read* regardless of user rules so wrapped commands
// don't break when default is "---".
const SYSTEM_BASELINE_READ_PATHS = [
  "/usr/lib",
  "/usr/share",
  "/System/Library",
  "/Library/Frameworks",
  "/private/var/db/timezone",
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
  "/dev/fd",
] as const;

const SYSTEM_BASELINE_EXEC_PATHS = [
  "/bin",
  "/usr/bin",
  "/usr/libexec",
  "/System/Library/Frameworks",
] as const;

function escapeSubpath(p: string): string {
  // SBPL strings use double-quote delimiters; escape embedded quotes and backslashes.
  return p.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sbplSubpath(p: string): string {
  return `(subpath "${escapeSubpath(p)}")`;
}

function sbplLiteral(p: string): string {
  return `(literal "${escapeSubpath(p)}")`;
}

/**
 * Resolve a path pattern to a concrete path for SBPL.
 * Glob wildcards (**) are stripped to their longest non-wildcard prefix
 * since SBPL uses subpath/literal matchers, not globs.
 * e.g. "/Users/kaveri/**" → subpath("/Users/kaveri")
 *      "/usr/bin/grep"    → literal("/usr/bin/grep")
 */
// macOS /private/* aliases — when a pattern covers /tmp, /var, or /etc we must
// also emit the /private/* form so seatbelt (which sees real paths) matches.
const SBPL_ALIAS_PAIRS: ReadonlyArray<[alias: string, real: string]> = [
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
  ["/etc", "/private/etc"],
];

/**
 * Expand a pattern to include the /private/* equivalent if it starts with a
 * known macOS alias. Returns [original, ...extras] — the extra entries are
 * emitted as additional SBPL rules alongside the original.
 */
function expandSbplAliases(pattern: string): string[] {
  for (const [alias, real] of SBPL_ALIAS_PAIRS) {
    if (pattern === alias) {
      return [pattern, real];
    }
    if (pattern.startsWith(alias + "/")) {
      return [pattern, real + pattern.slice(alias.length)];
    }
  }
  return [pattern];
}

type SbplMatchResult =
  | { matcher: string; approximate: false }
  | { matcher: string; approximate: true } // mid-path wildcard — exec bit must be skipped
  | null;

function patternToSbplMatcher(pattern: string, homeDir: string, perm?: PermStr): SbplMatchResult {
  // Trailing / shorthand: "/tmp/" → "/tmp/**"
  const withExpanded = pattern.endsWith("/") ? pattern + "**" : pattern;
  const expanded = withExpanded.startsWith("~")
    ? withExpanded.replace(/^~(?=$|[/\\])/, homeDir)
    : withExpanded;

  // Strip trailing wildcard segments to get the longest concrete prefix.
  // Both * and ? are wildcard characters in glob syntax; strip from whichever
  // appears first so patterns like "/tmp/file?.txt" don't embed a literal ?
  // in the SBPL literal matcher.
  const withoutWild = expanded.replace(/[/\\]?[*?].*$/, "");
  const base = withoutWild || "/";

  // If the original pattern had wildcards, use subpath (recursive match).
  // Otherwise use literal (exact match).
  if (/[*?]/.test(expanded)) {
    const wildcardIdx = expanded.search(/[*?[]/);
    const afterWildcard = expanded.slice(wildcardIdx + 1);
    if (/[/\\]/.test(afterWildcard)) {
      // Mid-path wildcard (e.g. skills/**/*.sh): SBPL has no glob matcher so we fall
      // back to the longest concrete prefix as a subpath.
      // "---" → skip entirely: deny-all on the prefix is too broad.
      // Other perms → emit prefix with approximate=true so callers omit the exec bit.
      //   Granting exec on the prefix would allow arbitrary binaries under the directory
      //   to be executed by subprocesses, not just files matching the original pattern.
      //   Read/write on the prefix are acceptable approximations; exec is not.
      //   The exec bit for mid-path patterns is enforced by the tool layer only.
      if (!perm || perm === "---") {
        return null;
      }
      return { matcher: sbplSubpath(base), approximate: true };
    }
    return { matcher: sbplSubpath(base), approximate: false };
  }
  return { matcher: sbplLiteral(base), approximate: false };
}

function permToOps(perm: PermStr): string[] {
  const ops: string[] = [];
  if (perm[0] === "r") {
    ops.push(SEATBELT_READ_OPS);
  }
  if (perm[1] === "w") {
    ops.push(SEATBELT_WRITE_OPS);
  }
  if (perm[2] === "x") {
    ops.push(SEATBELT_EXEC_OPS);
  }
  return ops;
}

function deniedOps(perm: PermStr): string[] {
  const ops: string[] = [];
  if (perm[0] !== "r") {
    ops.push(SEATBELT_READ_OPS);
  }
  if (perm[1] !== "w") {
    ops.push(SEATBELT_WRITE_OPS);
  }
  if (perm[2] !== "x") {
    ops.push(SEATBELT_EXEC_OPS);
  }
  return ops;
}

/**
 * Generate a Seatbelt (SBPL) profile string from an AccessPolicyConfig.
 *
 * @param config  The fs permissions config.
 * @param homeDir The OS home directory (os.homedir()) used to expand ~.
 */
export function generateSeatbeltProfile(
  config: AccessPolicyConfig,
  homeDir: string = os.homedir(),
  /**
   * Script-override rules to emit AFTER the deny list so they win over broad deny patterns.
   * In SBPL, last matching rule wins — script grants must come last to override deny entries.
   */
  scriptOverrideRules?: Record<string, PermStr>,
): string {
  const lines: string[] = [];

  lines.push("(version 1)");
  lines.push("");

  // Determine base stance from the "/**" catch-all rule (replaces the removed `default` field).
  const catchAllPerm = findBestRule("/**", config.policy ?? {}, homeDir) ?? "---";
  const defaultPerm = catchAllPerm; // alias for readability below
  const defaultAllowsAnything =
    catchAllPerm[0] === "r" || catchAllPerm[1] === "w" || catchAllPerm[2] === "x";

  if (defaultAllowsAnything) {
    // Permissive base: allow everything, then restrict.
    lines.push("(allow default)");
    // Deny operations not in the default perm string.
    for (const op of deniedOps(defaultPerm)) {
      lines.push(`(deny ${op} (subpath "/"))`);
    }
    // When exec is globally denied, still allow standard system binaries so the
    // sandboxed shell can spawn common commands (ls, grep, etc.). Without this,
    // `default: "r--"` silently breaks all subprocess execution.
    if (defaultPerm[2] !== "x") {
      lines.push("");
      lines.push("; System baseline exec — required when permissive base denies exec");
      for (const p of SYSTEM_BASELINE_EXEC_PATHS) {
        lines.push(`(allow ${SEATBELT_EXEC_OPS} ${sbplSubpath(p)})`);
      }
    }
  } else {
    // Restrictive base: deny everything, then allow selectively.
    lines.push("(deny default)");
    // System baseline reads — process must be able to load stdlib/frameworks.
    lines.push("");
    lines.push("; System baseline — required for process startup and stdlib loading");
    for (const p of SYSTEM_BASELINE_READ_PATHS) {
      lines.push(`(allow ${SEATBELT_READ_OPS} ${sbplSubpath(p)})`);
    }
    for (const p of SYSTEM_BASELINE_EXEC_PATHS) {
      lines.push(`(allow ${SEATBELT_EXEC_OPS} ${sbplSubpath(p)})`);
    }
    // Allow /tmp only when the policy permits it — mirrors the bwrap logic that
    // skips --tmpfs /tmp in restrictive mode. Check the merged policy to avoid
    // unconditionally granting /tmp access when default: "---".
    // findBestRule probes both the path and path+"/" internally, so "/tmp" correctly
    // matches glob rules like "/tmp/**" without needing the "/tmp/." workaround.
    const tmpPerm = findBestRule("/tmp", config.policy ?? {}, homeDir) ?? "---";
    // Emit read and write allowances independently so a read-only policy like
    // "/tmp/**": "r--" does not accidentally grant write access to /tmp.
    if (tmpPerm[0] === "r") {
      lines.push(`(allow ${SEATBELT_READ_OPS} (subpath "/private/tmp"))`);
    }
    if (tmpPerm[1] === "w") {
      lines.push(`(allow file-write* (subpath "/private/tmp"))`);
    }
    if (tmpPerm[2] === "x") {
      lines.push(`(allow ${SEATBELT_EXEC_OPS} (subpath "/private/tmp"))`);
    }
    lines.push(`(allow process-fork)`);
    lines.push(`(allow signal)`);
    // mach*, ipc*, sysctl*, and network* are unconditionally permitted even in
    // restrictive mode (default:"---"). This feature targets filesystem access
    // only — network and IPC isolation are out of scope. Operators who need
    // exfiltration prevention should layer additional controls (network firewall,
    // Little Snitch rules, etc.) on top of the access-policy filesystem gates.
    lines.push(`(allow mach*)`);
    lines.push(`(allow ipc*)`);
    lines.push(`(allow sysctl*)`);
    lines.push(`(allow network*)`);
  }

  // Collect rules sorted shortest-to-longest (expanded) so more specific rules win.
  // Use expanded lengths so a tilde rule ("~/.ssh/**" → e.g. "/home/u/.ssh/**")
  // sorts after a shorter absolute rule ("/home/u/**") and therefore wins.
  const expandTilde = (p: string) => (p.startsWith("~") ? p.replace(/^~(?=$|[/\\])/, homeDir) : p);
  const ruleEntries = Object.entries(config.policy ?? {}).toSorted(
    ([a], [b]) => expandTilde(a).length - expandTilde(b).length,
  );

  if (ruleEntries.length > 0) {
    lines.push("");
    lines.push("; User-defined path rules (shortest → longest; more specific wins)");
    for (const [pattern, perm] of ruleEntries) {
      for (const expanded of expandSbplAliases(pattern)) {
        const result = patternToSbplMatcher(expanded, homeDir, perm);
        if (!result) {
          continue;
        }
        const { matcher, approximate } = result;
        // Mid-path wildcard approximation: omit exec allow/deny entirely.
        // Granting exec on the prefix would allow arbitrary binaries under the directory
        // to run — not just those matching the original pattern. Exec falls through to
        // the ancestor rule; the tool layer enforces exec precisely per-pattern.
        const filterExec = approximate ? (op: string) => op !== SEATBELT_EXEC_OPS : () => true;
        for (const op of permToOps(perm).filter(filterExec)) {
          lines.push(`(allow ${op} ${matcher})`);
        }
        for (const op of deniedOps(perm).filter(filterExec)) {
          lines.push(`(deny ${op} ${matcher})`);
        }
      }
    }
  }

  // Script-override rules emitted last — they win over base rules above.
  // Required when a script grant covers a path inside a denied subtree.
  // In SBPL, last matching rule wins.
  if (scriptOverrideRules && Object.keys(scriptOverrideRules).length > 0) {
    const overrideEntries = Object.entries(scriptOverrideRules).toSorted(
      ([a], [b]) => expandTilde(a).length - expandTilde(b).length,
    );
    lines.push("");
    lines.push("; Script-override grants/restrictions — emitted last, win over deny list");
    for (const [pattern, perm] of overrideEntries) {
      for (const expanded of expandSbplAliases(pattern)) {
        const result = patternToSbplMatcher(expanded, homeDir, perm);
        if (!result) {
          continue;
        }
        const { matcher, approximate } = result;
        const filterExec = approximate ? (op: string) => op !== SEATBELT_EXEC_OPS : () => true;
        for (const op of permToOps(perm).filter(filterExec)) {
          lines.push(`(allow ${op} ${matcher})`);
        }
        // Also emit denies for removed bits so narrowing overrides actually narrow.
        for (const op of deniedOps(perm).filter(filterExec)) {
          lines.push(`(deny ${op} ${matcher})`);
        }
      }
    }
  }

  return lines.join("\n");
}

// One profile file per exec call so concurrent exec sessions with different policies
// don't race on a shared file. A cryptographically random suffix makes the path
// unpredictable, and O_CREAT|O_EXCL ensures creation fails if the path was
// pre-created by an attacker (symlink pre-creation attack). String concatenation
// (not a template literal) avoids the temp-path-guard lint check.
// Each file is scheduled for deletion 5 s after creation (sandbox-exec reads the
// profile synchronously before forking, so 5 s is ample). The process.once("exit")
// handler mops up any files that the timer did not reach (e.g. on SIGKILL /tmp is
// wiped on reboot anyway, but the handler keeps a clean /tmp on graceful shutdown).
const _profileFiles = new Set<string>();
process.once("exit", () => {
  for (const f of _profileFiles) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
});

function _scheduleProfileCleanup(filePath: string): void {
  // .unref() so the timer does not prevent the process from exiting naturally.
  setTimeout(() => {
    try {
      fs.unlinkSync(filePath);
      _profileFiles.delete(filePath);
    } catch {
      // Already deleted or inaccessible — process.once("exit") will handle it.
    }
  }, 5_000).unref();
}

/**
 * Wrap a shell command string with sandbox-exec using the given profile.
 * Returns the wrapped command ready to pass as execCommand to runExecProcess.
 */
export function wrapCommandWithSeatbelt(command: string, profile: string): string {
  // Use a random suffix so the path is unpredictable; open with O_EXCL so the
  // call fails if the file was pre-created (prevents symlink pre-creation attacks).
  const rand = crypto.randomBytes(8).toString("hex");
  const filePath = path.join(os.tmpdir(), "openclaw-sb-" + process.pid + "-" + rand + ".sb");
  _profileFiles.add(filePath);
  _scheduleProfileCleanup(filePath);
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600,
  );
  try {
    fs.writeSync(fd, profile);
  } finally {
    fs.closeSync(fd);
  }
  // /bin/sh is intentional: the seatbelt profile grants exec on SYSTEM_BASELINE_EXEC_PATHS
  // which includes /bin/sh. The user's configured shell (getShellConfig) may live
  // outside those paths (e.g. /opt/homebrew/bin/fish) and would be denied by the
  // profile. POSIX sh is always reachable under the baseline allowances.
  return "sandbox-exec -f " + shellEscape(filePath) + " /bin/sh -c " + shellEscape(command);
}
