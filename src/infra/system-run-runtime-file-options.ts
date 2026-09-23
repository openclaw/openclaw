/** Rejects runtime options whose file/cwd effects cannot fit one operand binding. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import { parseInlineOptionToken } from "./inline-option-token.js";
import {
  BUN_UNBINDABLE_APPROVAL_OPTIONS,
  DENO_UNBINDABLE_APPROVAL_OPTIONS,
  PERL_UNSAFE_APPROVAL_FLAGS,
} from "./system-run-mutable-file-options.js";

function hasListedOption(argv: string[], options: ReadonlySet<string>): boolean {
  return argv
    .slice(1)
    .some((token) =>
      options.has(normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name)),
    );
}

function hasPhpUnbindableOption(argv: string[]): boolean {
  return argv.slice(1).some((token) => {
    const normalized = token.trim().toLowerCase();
    return (
      normalized === "-c" ||
      normalized.startsWith("-c=") ||
      normalized === "--php-ini" ||
      normalized.startsWith("--php-ini=") ||
      normalized === "-d" ||
      normalized.startsWith("-d")
    );
  });
}

export function hasUnbindableRuntimeApprovalOption(params: {
  argv: string[];
  executable: string;
}): boolean {
  if (params.executable === "bun") {
    return hasListedOption(params.argv, BUN_UNBINDABLE_APPROVAL_OPTIONS);
  }
  if (params.executable === "deno") {
    return hasListedOption(params.argv, DENO_UNBINDABLE_APPROVAL_OPTIONS);
  }
  return params.executable === "php" && hasPhpUnbindableOption(params.argv);
}
export function hasPerlUnsafeApprovalFlag(argv: string[]): boolean {
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = normalizeNullableString(argv[i]) ?? "";
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return false;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-I" || token === "-M" || token === "-m" || token === "-S") {
      return true;
    }
    if (token.startsWith("-I") || token.startsWith("-M") || token.startsWith("-m")) {
      return true;
    }
    if (PERL_UNSAFE_APPROVAL_FLAGS.has(token)) {
      return true;
    }
  }
  return false;
}
