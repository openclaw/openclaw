// Validates safe-bin policy profiles against command argv semantics.
import { parseExecArgvToken } from "./exec-command-resolution.js";
import {
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  type SafeBinProfile,
} from "./exec-safe-bin-policy-profiles.js";
import { validateSafeBinSemantics } from "./exec-safe-bin-semantics.js";

function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed)
  );
}

function isSafeLiteralToken(value: string): boolean {
  // Safe bins are stdin-only; execution-time expansion is hardened separately.
  return (
    !/[*?[\]]/.test(value) &&
    !/\$(?:[A-Za-z0-9_@*?!$#-]|\{|\(|\[)/.test(value) &&
    !isPathLikeToken(value)
  );
}

const NO_FLAGS: ReadonlySet<string> = new Set();

export function validateSafeBinArgv(
  args: string[],
  profile: SafeBinProfile,
  options?: { binName?: string },
): boolean {
  const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
  const allowedBooleanFlags = profile.allowedBooleanFlags ?? NO_FLAGS;
  const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
  const knownLongFlags =
    profile.knownLongFlags ??
    collectKnownLongFlags(allowedValueFlags, deniedFlags, allowedBooleanFlags);
  const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
  const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);

  function consumeValue(index: number, inlineValue: string | undefined): number {
    if (inlineValue !== undefined) {
      return isSafeLiteralToken(inlineValue) ? index + 1 : -1;
    }
    const value = args[index + 1];
    return value && isSafeLiteralToken(value) ? index + 2 : -1;
  }

  const positional: string[] = [];
  let optionsEnded = false;
  let i = 0;
  while (i < args.length) {
    const token = parseExecArgvToken(args[i] ?? "");
    if (token.kind === "empty" || token.kind === "stdin") {
      i += 1;
      continue;
    }
    if (optionsEnded || token.kind === "positional") {
      if (!isSafeLiteralToken(token.raw)) {
        return false;
      }
      positional.push(token.raw);
      i += 1;
      continue;
    }
    if (token.kind === "terminator") {
      optionsEnded = true;
      i += 1;
      continue;
    }

    let nextIndex = i + 1;
    if (token.style === "long") {
      const flag =
        token.flag.length > 2
          ? knownLongFlagsSet.has(token.flag)
            ? token.flag
            : longFlagPrefixMap.get(token.flag)
          : undefined;
      if (!flag || deniedFlags.has(flag)) {
        return false;
      }
      if (allowedValueFlags.has(flag)) {
        nextIndex = consumeValue(i, token.inlineValue);
      } else if (token.inlineValue !== undefined) {
        return false;
      }
    } else {
      for (const [j, flag] of token.flags.entries()) {
        if (deniedFlags.has(flag)) {
          return false;
        }
        if (allowedValueFlags.has(flag)) {
          nextIndex = consumeValue(i, token.cluster.slice(j + 1) || undefined);
          break;
        }
        if (!allowedBooleanFlags.has(flag)) {
          return false;
        }
      }
    }
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  if (
    positional.length < (profile.minPositional ?? 0) ||
    (typeof profile.maxPositional === "number" && positional.length > profile.maxPositional)
  ) {
    return false;
  }
  return validateSafeBinSemantics({ binName: options?.binName, positional });
}
