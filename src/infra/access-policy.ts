import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccessPolicyConfig, PermStr } from "../config/types.tools.js";
import { matchesExecAllowlistPattern } from "./exec-allowlist-pattern.js";

export type FsOp = "read" | "write" | "exec";

const PERM_STR_RE = /^[r-][w-][x-]$/;

// Track patterns already auto-expanded so the diagnostic fires once per process,
// not once per agent turn (the policy file is re-read fresh on every turn).
const _autoExpandedWarned = new Set<string>();

/** Reset the one-time auto-expand warning set. Only for use in tests. */
export function _resetAutoExpandedWarnedForTest(): void {
  _autoExpandedWarned.clear();
}

// Track mid-path wildcard patterns already warned about — one diagnostic per pattern.
const _midPathWildcardWarned = new Set<string>();

/** Reset the mid-path wildcard warning set. Only for use in tests. */
export function _resetMidPathWildcardWarnedForTest(): void {
  _midPathWildcardWarned.clear();
}

/**
 * Returns true when a glob pattern has a wildcard character (*, ?, or bracket)
 * in a non-final path segment (e.g. "/home/*\/secrets/**").
 * bwrap and Seatbelt both skip such patterns at the OS layer because the
 * concrete mount/deny path cannot be derived — only the tool layer enforces them.
 */
function hasMidPathWildcard(pattern: string): boolean {
  const wildcardIdx = pattern.search(/[*?[]/);
  if (wildcardIdx === -1) {
    return false;
  }
  return /[/\\]/.test(pattern.slice(wildcardIdx));
}

/**
 * Validates and normalizes an AccessPolicyConfig for well-formedness.
 * Returns an array of human-readable diagnostic strings; empty = valid.
 * May mutate config.rules in place (e.g. auto-expanding bare directory paths).
 */
export function validateAccessPolicyConfig(config: AccessPolicyConfig): string[] {
  const errors: string[] = [];

  if (config.rules) {
    for (const [pattern, perm] of Object.entries(config.rules)) {
      if (!pattern) {
        errors.push("access-policy.rules: rule key must be a non-empty glob pattern");
      }
      if (!PERM_STR_RE.test(perm)) {
        errors.push(
          `access-policy.rules["${pattern}"] "${perm}" is invalid: must be exactly 3 chars (e.g. "rwx", "r--", "---")`,
        );
      }
      if (hasMidPathWildcard(pattern) && !_midPathWildcardWarned.has(`rules:${pattern}`)) {
        _midPathWildcardWarned.add(`rules:${pattern}`);
        if (perm === "---") {
          // Deny-all on a mid-path wildcard prefix would be too broad at the OS layer
          // (e.g. "secrets/**/*.env: ---" → deny all of secrets/). Skip OS emission entirely.
          errors.push(
            `access-policy.rules["${pattern}"] contains a mid-path wildcard with "---" — OS-level (bwrap/Seatbelt) enforcement cannot apply; tool-layer enforcement is still active.`,
          );
        } else {
          // For non-deny rules the OS layer uses the longest concrete prefix as an
          // approximate mount/subpath target. The file-type filter (e.g. *.sh) is enforced
          // precisely by the tool layer only.
          errors.push(
            `access-policy.rules["${pattern}"] contains a mid-path wildcard — OS-level enforcement uses prefix match (file-type filter is tool-layer only).`,
          );
        }
      }
      // If a bare path (no glob metacharacters, no trailing /) points to a real
      // directory it would match only the directory entry itself, not its
      // contents. Auto-expand to "/**" and notify — the fix is unambiguous.
      // Any stat failure means the agent faces the same error (ENOENT/EACCES),
      // so the rule is a no-op and no action is needed.
      if (pattern && !pattern.endsWith("/") && !/[*?[]/.test(pattern)) {
        const expanded = pattern.startsWith("~")
          ? pattern.replace(/^~(?=$|\/)/, os.homedir())
          : pattern;
        try {
          if (fs.statSync(expanded).isDirectory()) {
            const fixed = `${pattern}/**`;
            // Only write the expanded key if no explicit glob for this path already
            // exists — overwriting an existing "/**" rule would silently widen access
            // (e.g. {"/tmp":"rwx","/tmp/**":"---"} would become {"/tmp/**":"rwx"}).
            if (!(fixed in config.rules)) {
              config.rules[fixed] = perm;
            }
            delete config.rules[pattern];
            if (!_autoExpandedWarned.has(pattern)) {
              _autoExpandedWarned.add(pattern);
              errors.push(
                `access-policy.rules["${pattern}"] is a directory — rule auto-expanded to "${fixed}" so it covers all contents.`,
              );
            }
          }
        } catch {
          // Path inaccessible or missing — no action needed.
        }
      }
    }
  }

  if (config.scripts) {
    for (const [scriptPath, entry] of Object.entries(config.scripts)) {
      if (entry.rules) {
        for (const [pattern, perm] of Object.entries(entry.rules)) {
          if (!PERM_STR_RE.test(perm)) {
            errors.push(
              `access-policy.scripts["${scriptPath}"].rules["${pattern}"] "${perm}" is invalid: must be exactly 3 chars (e.g. "rwx", "r--", "---")`,
            );
          }
        }
      }
    }
  }

  return errors;
}

/**
 * Normalize and expand a config pattern before matching:
 *   - Trailing "/" is shorthand for "/**" (everything under this directory).
 *     e.g. "/tmp/" → "/tmp/**", "~/" → "~/**"
 *   - Leading "~" is expanded to the OS home directory.
 *
 * We intentionally use os.homedir() rather than expandHomePrefix() so that
 * OPENCLAW_HOME does not redirect ~ to the OpenClaw config directory.
 */
function expandPattern(pattern: string, homeDir: string): string {
  // Trailing / shorthand: "/tmp/" → "/tmp/**"
  const normalized = pattern.endsWith("/") ? pattern + "**" : pattern;
  if (!normalized.startsWith("~")) {
    return normalized;
  }
  return normalized.replace(/^~(?=$|[/\\])/, homeDir);
}

/**
 * macOS maps several traditional Unix root directories to /private/* via symlinks.
 * Kernel-level enforcement (seatbelt) sees the real /private/* paths, but users
 * naturally write /tmp, /var, /etc in their config.
 *
 * We normalize the target path to its "friendly" alias before matching so that
 * /private/tmp/foo is treated as /tmp/foo everywhere — no need to write both.
 *
 * Only applied on darwin; on other platforms the map is empty (no-op).
 */
const MACOS_PRIVATE_ALIASES: ReadonlyArray<[real: string, alias: string]> =
  process.platform === "darwin"
    ? [
        ["/private/tmp", "/tmp"],
        ["/private/var", "/var"],
        ["/private/etc", "/etc"],
      ]
    : [];

function normalizePlatformPath(p: string): string {
  for (const [real, alias] of MACOS_PRIVATE_ALIASES) {
    if (p === real) {
      return alias;
    }
    if (p.startsWith(real + "/")) {
      return alias + p.slice(real.length);
    }
  }
  return p;
}

// Maps operation to its index in the rwx permission string.
const OP_INDEX: Record<FsOp, number> = {
  read: 0,
  write: 1,
  exec: 2,
};

// The exact character that grants each operation. Any other character (including
// typos like "1", "y", "R") is treated as deny — fail-closed on malformed input.
const OP_GRANT_CHAR: Record<FsOp, string> = {
  read: "r",
  write: "w",
  exec: "x",
};

/**
 * Returns true if the given permission string grants the requested operation.
 * An absent or malformed string is treated as "---" (deny all).
 * Only the exact grant character ("r"/"w"/"x") is accepted — any other value
 * including typos fails closed rather than accidentally granting access.
 */
function permAllows(perm: PermStr | undefined, op: FsOp): boolean {
  if (!perm) {
    return false;
  }
  return perm[OP_INDEX[op]] === OP_GRANT_CHAR[op];
}

/**
 * Finds the most specific matching rule for targetPath using longest-glob-wins.
 * Returns the permission string for that rule, or null if nothing matches.
 */
export function findBestRule(
  targetPath: string,
  rules: Record<string, PermStr>,
  homeDir: string = os.homedir(),
): PermStr | null {
  let bestPerm: PermStr | null = null;
  let bestLen = -1;

  for (const [pattern, perm] of Object.entries(rules)) {
    // Normalize the expanded pattern so /private/tmp/** matches /tmp/** on macOS.
    const expanded = normalizePlatformPath(expandPattern(pattern, homeDir));
    // Test both the bare path and path + "/" so that "dir/**"-style rules match
    // the directory itself — mirrors the dual-probe in checkAccessPolicy so
    // callers don't need to remember to append "/." when passing a directory.
    if (
      matchesExecAllowlistPattern(expanded, targetPath) ||
      matchesExecAllowlistPattern(expanded, targetPath + "/")
    ) {
      // Longer *expanded* pattern = more specific. Compare expanded lengths so
      // a tilde rule like "~/.ssh/**" (expanded: "/home/user/.ssh/**", 20 chars)
      // correctly beats a broader absolute rule like "/home/user/**" (14 chars).
      if (expanded.length > bestLen) {
        bestLen = expanded.length;
        bestPerm = perm;
      }
    }
  }

  return bestPerm;
}

/**
 * Checks whether a given operation on targetPath is permitted by the config.
 *
 * Precedence:
 *   1. rules  — longest matching glob wins; check the relevant bit.
 *   2. implicit fallback — `"---"` (deny-all) when no rule matches.
 *      Use `"/**": "r--"` (or any other perm) as an explicit catch-all rule.
 */
export function checkAccessPolicy(
  targetPath: string,
  op: FsOp,
  config: AccessPolicyConfig,
  homeDir: string = os.homedir(),
): "allow" | "deny" {
  // Expand leading ~ in targetPath so callers don't have to pre-expand tilde paths.
  const expandedTarget = targetPath.startsWith("~")
    ? targetPath.replace(/^~(?=$|\/)/, homeDir)
    : targetPath;
  // Normalize /private/tmp → /tmp etc. so macOS symlink aliases are transparent.
  const normalizedPath = normalizePlatformPath(expandedTarget);
  // For directory-level checks (e.g. mkdir), also try path + "/" so that a
  // trailing-/ rule ("~/.openclaw/heartbeat/" → "/**") covers the directory
  // itself and not only its descendants.
  const normalizedPathDir = normalizedPath + "/";

  function matchesPattern(expanded: string): boolean {
    return (
      matchesExecAllowlistPattern(expanded, normalizedPath) ||
      matchesExecAllowlistPattern(expanded, normalizedPathDir)
    );
  }

  // rules — longest match wins (check both path and path + "/" variants).
  let bestPerm: PermStr | null = null;
  let bestLen = -1;
  for (const [pattern, perm] of Object.entries(config.rules ?? {})) {
    // Normalize so /private/tmp/** patterns match /tmp/** targets on macOS.
    const expanded = normalizePlatformPath(expandPattern(pattern, homeDir));
    if (matchesPattern(expanded) && expanded.length > bestLen) {
      bestLen = expanded.length;
      bestPerm = perm;
    }
  }
  if (bestPerm !== null) {
    return permAllows(bestPerm, op) ? "allow" : "deny";
  }

  // Implicit fallback: "---" (deny-all) when no rule matches.
  return "deny";
}

/**
 * Search PATH for a bare binary name, returning the first executable found.
 * Returns null when not found. The caller applies realpathSync afterwards.
 */
function findOnPath(name: string, pathOverride?: string): string | null {
  const pathEnv = pathOverride ?? process.env.PATH ?? "";
  // On Windows, bare names like "node" resolve to "node.exe" or "node.cmd" via
  // PATHEXT. Without probing extensions, accessSync finds nothing and we fall back
  // to the cwd-relative path, causing checkAccessPolicy to evaluate the wrong path.
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(path.delimiter)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // not in this dir/ext combo
      }
    }
  }
  return null;
}

/**
 * Extract and resolve the argv[0] token from a shell command string.
 *
 * Handles leading-quoted paths ("..." and '...') and simple unquoted tokens.
 * Expands ~ to os.homedir(). Resolves relative paths against cwd.
 * Follows symlinks via realpathSync so the result matches an absolute-path key.
 *
 * Returns null when the command is empty or the path cannot be determined.
 */
export function resolveArgv0(command: string, cwd?: string, _depth = 0): string | null {
  // Guard against deeply nested env -S "env -S '...'" constructs that would
  // otherwise overflow the call stack. 8 levels is far more than any real usage.
  if (_depth > 8) {
    return null;
  }
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  // Extract the first token, respecting simple leading quotes.
  // Skip leading shell env-prefix assignments (e.g. FOO=1 /script.sh → /script.sh)
  // so that script policy lookups and sha256 checks are not bypassed by prefixed envs.
  let token: string;
  // commandRest holds the tail of the command string after argv0 — used to look
  // through `env` invocations where the real script follows the launcher.
  let commandRest = "";
  // Literal PATH= override extracted from env-prefix assignments (no shell vars).
  // Used so `PATH=/alt deploy.sh` looks up deploy.sh on /alt rather than process PATH.
  let commandScopedPath: string | undefined;
  if (trimmed[0] === '"' || trimmed[0] === "'") {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    token = end !== -1 ? trimmed.slice(1, end) : trimmed.slice(1);
    // Set commandRest so the env look-through below can strip the quoted argv0 and
    // recurse into the actual script (e.g. `"/usr/bin/env" /my/script.sh` → /my/script.sh).
    commandRest = trimmed;
  } else {
    // Progressively consume leading NAME=value env-prefix tokens before extracting argv0.
    // Using a regex that matches the full assignment including quoted values (e.g.
    // FOO='a b') prevents misparse when a quoted env value contains spaces — a naive
    // whitespace-split would break FOO='a b' /script.sh into ["FOO='a", "b'", "/script.sh"]
    // and incorrectly treat "b'" as the argv0, bypassing script policy lookups.
    const envPrefixRe = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/;
    let rest = trimmed;
    while (envPrefixRe.test(rest)) {
      // Capture a literal PATH= override; skip if the value contains $ (unexpandable).
      const pathM = rest.match(/^PATH=(?:"([^"]*)"|'([^']*)'|(\S+))\s*/);
      if (pathM) {
        const val = pathM[1] ?? pathM[2] ?? pathM[3] ?? "";
        if (!val.includes("$")) {
          commandScopedPath = val;
        }
      }
      rest = rest.replace(envPrefixRe, "");
    }
    const raw = rest.split(/\s+/)[0] ?? "";
    // If the argv0 token is quoted (e.g. FOO=1 "/opt/my script.sh"), strip quotes.
    if (raw[0] === '"' || raw[0] === "'") {
      const quote = raw[0];
      const end = rest.indexOf(quote, 1);
      token = end !== -1 ? rest.slice(1, end) : rest.slice(1);
    } else {
      token = raw;
    }
    commandRest = rest;
  }
  if (!token) {
    return null;
  }
  // Expand leading ~
  if (token.startsWith("~")) {
    token = token.replace(/^~(?=$|\/)/, os.homedir());
  }
  // Resolve relative paths. For bare names with no path separator (e.g. "deploy.sh"),
  // try PATH lookup first so script-policy keys match the real on-PATH binary rather
  // than <cwd>/deploy.sh. Explicitly relative tokens (./foo, ../foo) contain a separator
  // and are resolved against cwd only, matching the shell's own behaviour.
  if (!path.isAbsolute(token)) {
    const hasPathSep = token.includes("/") || token.includes("\\");
    if (!hasPathSep) {
      const onPath = findOnPath(token, commandScopedPath);
      if (onPath) {
        token = onPath;
      } else if (cwd) {
        token = path.resolve(cwd, token);
      } else {
        return null;
      }
    } else if (cwd) {
      token = path.resolve(cwd, token);
    } else {
      return null;
    }
  }
  // Follow symlinks so keys always refer to the real file
  try {
    token = fs.realpathSync(token);
  } catch {
    // token stays as-is
  }

  // If the resolved binary is `env` (e.g. `env FOO=1 /script.sh`), look past it
  // to the actual script so script-policy lookups and sha256 checks are not bypassed
  // by prepending `env`. Recurse so the inner command gets the same full treatment
  // (NAME=value stripping, quoting, cwd-relative resolution, symlink following).
  if (path.basename(token, path.extname(token)) === "env" && commandRest) {
    // Strip the env/"/usr/bin/env" token itself from commandRest.
    let afterEnv = commandRest.replace(/^\S+\s*/, "");
    // Skip env options and their arguments so `env -i /script.sh` resolves to
    // /script.sh rather than treating `-i` as argv0. Short options that consume
    // the next token as their argument (-u VAR, -C DIR) are stripped including
    // any quoted value (e.g. -C "/path with space"). -S/--split-string is special:
    // its value IS a command string, so we recurse into it rather than discard it.
    // All other flags (e.g. -i, --ignore-environment) are single standalone tokens.
    // NAME=value pairs are handled naturally when we recurse into resolveArgv0.
    // --block-signal, --default-signal, --ignore-signal use [=SIG] syntax (never space-separated).
    const envOptWithArgRe = /^(-[uC]|--(unset|chdir))\s+/;
    while (afterEnv) {
      if (afterEnv === "--" || afterEnv.startsWith("-- ")) {
        afterEnv = afterEnv.slice(2).trimStart();
        break; // -- terminates env options; what follows is the command
      }
      // -S/--split-string: the argument is itself a command string — recurse into it.
      // Handle all three forms GNU env accepts:
      //   space:   -S CMD / --split-string CMD
      //   equals:  -S=CMD / --split-string=CMD
      //   compact: -SCMD  (short flag only, value starts immediately after -S)
      const splitEqM = afterEnv.match(/^(?:-S|--(split-string))=([\s\S]*)/);
      const splitSpM = afterEnv.match(/^(?:-S|--(split-string))\s+([\s\S]*)/);
      const splitCmM = afterEnv.match(/^-S([^\s=][\s\S]*)/);
      const splitArg = splitEqM
        ? splitEqM[splitEqM.length - 1]
        : splitSpM
          ? splitSpM[splitSpM.length - 1]
          : splitCmM
            ? splitCmM[1]
            : null;
      if (splitArg !== null) {
        let inner = splitArg.trim();
        // Strip surrounding quotes that the shell added around the embedded command.
        if (
          (inner.startsWith('"') && inner.endsWith('"')) ||
          (inner.startsWith("'") && inner.endsWith("'"))
        ) {
          inner = inner.slice(1, -1);
        }
        return inner ? resolveArgv0(inner, cwd, _depth + 1) : null;
      }
      if (envOptWithArgRe.test(afterEnv)) {
        // Strip option + its argument; handle quoted values with spaces.
        afterEnv = afterEnv.replace(/^\S+\s+(?:"[^"]*"|'[^']*'|\S+)\s*/, "");
      } else if (afterEnv[0] === "-") {
        afterEnv = afterEnv.replace(/^\S+\s*/, ""); // strip standalone flag
      } else {
        break; // first non-option token — may still be NAME=value, handled by recursion
      }
    }
    return afterEnv ? resolveArgv0(afterEnv, cwd, _depth + 1) : null;
  }

  return token;
}

/**
 * Normalize a scripts config key for comparison against a resolveArgv0 result.
 *
 * Expands a leading ~ and resolves symlinks for absolute paths, so that a key
 * like "/usr/bin/python" (symlink → /usr/bin/python3.12) still matches when
 * resolveArgv0 returns the real path "/usr/bin/python3.12".
 */
export function resolveScriptKey(k: string): string {
  // path.normalize converts forward slashes to OS-native separators on Windows so that
  // a tilde key like "~/bin/script.sh" compares correctly against a resolved argv0
  // that uses backslashes on Windows.
  const expanded = k.startsWith("~") ? path.normalize(k.replace(/^~(?=$|[/\\])/, os.homedir())) : k;
  if (!path.isAbsolute(expanded)) {
    return expanded;
  }
  try {
    return fs.realpathSync(expanded);
  } catch {
    // Key path doesn't exist — keep expanded; the lookup will simply not match.
    return expanded;
  }
}

/**
 * Apply a per-script policy overlay to the base agent policy.
 *
 * Looks up resolvedArgv0 in policy.scripts. If found:
 *   - verifies sha256 when set (returns hashMismatch=true on failure → caller should deny exec)
 *   - merges grant over base rules (override key wins)
 *   - appends restrict.deny to base deny (additive)
 *   - strips the scripts block from the result so the overlay doesn't apply to future
 *     unrelated exec calls in the same agent turn (seatbelt/bwrap still covers the full
 *     subprocess tree of the wrapped command at the OS level — that is correct behavior)
 *
 * Returns the base policy unchanged when no matching script entry exists.
 */
export function applyScriptPolicyOverride(
  policy: AccessPolicyConfig,
  resolvedArgv0: string,
): { policy: AccessPolicyConfig; overrideRules?: Record<string, PermStr>; hashMismatch?: true } {
  // Normalize scripts keys via resolveScriptKey so that:
  //   - tilde keys ("~/bin/deploy.sh") expand to absolute paths
  //   - symlink keys ("/usr/bin/python" → /usr/bin/python3.12) resolve to real paths
  // resolveArgv0 always returns the realpathSync result, so both forms must be
  // normalized the same way or the lookup silently misses, skipping sha256 verification.
  const scripts = policy.scripts;
  const override = scripts
    ? Object.entries(scripts).find(
        ([k]) => path.normalize(resolveScriptKey(k)) === path.normalize(resolvedArgv0),
      )?.[1]
    : undefined;
  if (!override) {
    return { policy };
  }

  // Verify sha256 when configured — reduces script swap risk.
  // Known limitation: there is an inherent TOCTOU window between the hash read
  // here and the kernel exec() call. An attacker who can swap the file between
  // these two moments could run a different payload under the per-script policy.
  // Fully closing this would require atomic open-and-exec (e.g. execveat + memfd)
  // which is not available in Node.js userspace. This check is a best-effort guard,
  // not a cryptographic guarantee. Use OS-level filesystem permissions to restrict
  // who can modify script files for stronger protection.
  if (override.sha256) {
    let actualHash: string;
    try {
      // Policy-engine internal read: intentionally bypasses checkAccessPolicy.
      // The policy engine must verify the script's integrity before deciding
      // whether to grant the script's extra permissions — checking the policy
      // first would be circular. This read is safe: it never exposes content
      // to the agent; it only computes a hash for comparison.
      const contents = fs.readFileSync(resolvedArgv0);
      actualHash = crypto.createHash("sha256").update(contents).digest("hex");
    } catch {
      return { policy, hashMismatch: true };
    }
    if (actualHash !== override.sha256) {
      return { policy, hashMismatch: true };
    }
  }

  // Build the merged policy WITHOUT the override rules merged in.
  // Override rules are returned separately so the caller can emit them AFTER
  // the base rules in the seatbelt profile (last-match-wins — grants must come
  // after broader rules to override them, e.g. a script-specific grant inside
  // a broadly denied subtree).
  const { scripts: _scripts, ...base } = policy;
  const merged: AccessPolicyConfig = { ...base };
  return {
    policy: merged,
    overrideRules:
      override.rules && Object.keys(override.rules).length > 0 ? override.rules : undefined,
  };
}
