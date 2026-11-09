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
      raw: params.segment.raw,
    });
  }
  if (!DEFAULT_SAFE_BUILTINS.has(head)) {
    return false;
  }
  if (head === "test") {
    return isSafePredicateBuiltinArgv(params.segment.argv, { raw: params.segment.raw });
  }
  return true;
}

function isSafePredicateBuiltinArgv(
  argv: ReadonlyArray<string | undefined>,
  params: { requiresClosingBracket?: boolean; raw: string },
): boolean {
  if (argv.some((token) => UNSAFE_PREDICATE_BUILTIN_OPERANDS.has(token?.trim() ?? ""))) {
    return false;
  }
  // The explainer owns decoded words (including concatenated command names). Check only
  // source expansion here: decoded argv alone misses ANSI-C quoting followed by a glob.
  // Scan the whole source instead of slicing by the decoded command name's length.
  const source = params.raw.trim();
  let quote: "single" | "double" | "ansi" | null = null;
  let atWordStart = true;
  let bareClosingBracket = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    if (char === "\0") {
      return false;
    }
    if (quote === "single") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === "\\") {
      if (!next) {
        return false;
      }
      if (quote === "ansi") {
        const numeric = source
          .slice(index + 1)
          .match(/^(?:[0-7]{1,3}|x[\dA-Fa-f]{1,2}|u[\dA-Fa-f]{1,4}|U[\dA-Fa-f]{1,8})/u)?.[0];
        if (numeric) {
          const octal = /^[0-7]/u.test(numeric);
          const value = octal ? Number.parseInt(numeric, 8) : Number.parseInt(numeric.slice(1), 16);
          // The explainer appends NUL instead of terminating the shell word and
          // decodes byte escapes as Unicode. Mismatched byte values or invalid
          // Unicode need normal approval, as do unsupported escapes below.
          const unicode = numeric.startsWith("u") || numeric.startsWith("U");
          if (
            value === 0 ||
            (unicode ? value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) : value > 0x7f)
          ) {
            return false;
          }
          index += numeric.length;
          continue;
        }
        if (!"'\"?\\abeEfnrtv".includes(next)) {
          return false;
        }
      }
      if (quote !== "double" || '\\"$`\n'.includes(next)) {
        index += 1;
      }
      atWordStart = false;
      continue;
    }
    if (quote === "ansi") {
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === "$" && quote === null && next === "'") {
      quote = "ansi";
      index += 1;
    } else if (char === "'" && quote === null) {
      quote = "single";
    } else if (char === '"') {
      quote = quote === "double" ? null : "double";
    } else if (
      char === "`" ||
      (char === "$" && /[A-Za-z0-9_@*?#$!{([-]/u.test(next)) ||
      (char === "$" && quote === null && next === '"')
    ) {
      return false;
    } else if (quote === null) {
      if (/\s/u.test(char)) {
        atWordStart = true;
        continue;
      }
      // The explainer omits the syntax-only final ] of an unquoted test_command.
      // Quoted/escaped ] is an ordinary operand and is checked through argv instead.
      const bracketHead = params.requiresClosingBracket && index === 0 && /\s/u.test(next);
      bareClosingBracket =
        params.requiresClosingBracket === true &&
        atWordStart &&
        index === source.length - 1 &&
        char === "]";
      if ("*?{}[]".includes(char) && !(char === "[" && bracketHead) && !bareClosingBracket) {
        return false;
      }
      if (char === "~" && atWordStart) {
        return false;
      }
    }
    atWordStart = false;
  }
  return (
    quote === null && (!params.requiresClosingBracket || argv.at(-1) === "]" || bareClosingBracket)
  );
}
