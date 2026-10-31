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
// in system-run-mutable-file-operand.ts. Other operand-blind trust here relies on builtins
// never re-evaluating operands as shell grammar; `test -v` in bash violates that invariant.
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
    });
  }
  if (!DEFAULT_SAFE_BUILTINS.has(head)) {
    return false;
  }
  if (head === "test") {
    return isSafePredicateBuiltinArgv(params.segment.argv, {});
  }
  return true;
}

function isSafePredicateBuiltinArgv(
  argv: ReadonlyArray<string | undefined>,
  params: { requiresClosingBracket?: boolean; fallbackRawCheck?: string },
): boolean {
  if (params.requiresClosingBracket) {
    if (argv.at(-1) !== "]" && !params.fallbackRawCheck?.trim().endsWith("]")) {
      return false;
    }
  }
  return !argv.some((token) => UNSAFE_PREDICATE_BUILTIN_OPERANDS.has(token?.trim() ?? ""));
}
