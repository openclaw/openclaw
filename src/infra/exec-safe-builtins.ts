// Classifies closed POSIX shell builtins for exec allowlist checks.
import { isWindowsPlatform, type ExecCommandSegment } from "./exec-approvals-analysis.js";

// POSIX shell builtins that cannot execute external code or mutate environment state on their
// own. Shell allowlist evaluation handles them as a closed internal set instead of path-based
// safeBins matching.
const DEFAULT_SAFE_BUILTINS: ReadonlySet<string> = new Set([
  ":",
  "cd",
  "false",
  "pwd",
  "test",
  "true",
]);

// Predicate builtins with a `-v` operand are excluded from the closed safe set: bash >= 4.2
// evaluates the array subscript of a `test -v` operand even inside single quotes, and that
// evaluation runs command substitution (e.g. `test -v 'a[$(cmd)]'`). Mirrors the same guard
// in system-run-mutable-file-operand.ts.
const UNSAFE_PREDICATE_BUILTIN_OPERANDS: ReadonlySet<string> = new Set(["-v"]);

/** Returns true when a parsed POSIX shell segment is one of the closed safe builtin forms. */
export function isSafeBuiltinSegment(params: {
  segment: ExecCommandSegment;
  platform?: string | null;
}): boolean {
  // Builtin semantics here are POSIX shell. On Windows the host shell is PowerShell, where
  // these tokens have different meaning (cd is an alias to Set-Location, etc.); defer.
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  // Builtin lookup in bash/zsh/dash is case-sensitive; classify only the exact token so an
  // external `TEST` binary on a case-insensitive filesystem is never treated as a builtin.
  const head = params.segment.argv[0]?.trim();
  if (!head) {
    return false;
  }
  if (head === "[") {
    return isSafePredicateBuiltinArgv(params.segment.argv, {
      requiresClosingBracket: true,
      fallbackRawCheck: params.segment.raw,
      head,
    });
  }
  if (!DEFAULT_SAFE_BUILTINS.has(head)) {
    return false;
  }
  if (head === "test") {
    return isSafePredicateBuiltinArgv(params.segment.argv, {
      fallbackRawCheck: params.segment.raw,
      head,
    });
  }
  return true;
}

function isSafePredicateBuiltinArgv(
  argv: ReadonlyArray<string | undefined>,
  params: { requiresClosingBracket?: boolean; fallbackRawCheck: string; head: "test" | "[" },
): boolean {
  if (params.requiresClosingBracket) {
    if (argv.at(-1) !== "]" && !params.fallbackRawCheck.trim().endsWith("]")) {
      return false;
    }
  }
  if (argv.some((token) => UNSAFE_PREDICATE_BUILTIN_OPERANDS.has(token?.trim() ?? ""))) {
    return false;
  }
  // The parsed argv can differ from what the shell executes (notably ANSI-C quoting followed
  // by a glob). Only static predicate source gets the builtin exemption; other forms need
  // normal approval even when the parsed operands look harmless.
  const source = params.fallbackRawCheck.trim();
  const afterHead = source.slice(params.head.length);
  if (!source.startsWith(params.head) || (afterHead.length > 0 && !/^\s/u.test(afterHead))) {
    return false;
  }
  const operands = source.slice(params.head.length, params.requiresClosingBracket ? -1 : undefined);
  for (const char of operands) {
    if ("\\$`*?{}[]".includes(char)) {
      return false;
    }
  }
  return true;
}
