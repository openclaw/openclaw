import { parseExecArgvToken } from "./exec-approvals-analysis.js";
import {
  buildLongFlagPrefixMap,
  collectKnownLongFlags,
  type SafeBinProfile,
} from "./exec-safe-bin-policy-profiles.js";

function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "-") {
    return false;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

function hasGlobToken(value: string): boolean {
  // Safe bins are stdin-only; globbing is both surprising and a historical bypass vector.
  // Note: we still harden execution-time expansion separately.
  return /[*?[\]]/.test(value);
}

/**
 * Detects shell variable expansion in a token (e.g. `$FOO`, `${FOO}`, `$(cmd)`).
 * Tokens with shell expansion are stripped from safeBin argv before validation
 * because the enforced command single-quotes all tokens, preventing actual expansion.
 */
export function hasShellExpansion(value: string): boolean {
  if (!value) {
    return false;
  }
  return /\$/.test(value);
}

const NO_FLAGS: ReadonlySet<string> = new Set();

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function isInvalidValueToken(value: string | undefined): boolean {
  return !value || !isSafeLiteralToken(value);
}

function resolveCanonicalLongFlag(params: {
  flag: string;
  knownLongFlagsSet: ReadonlySet<string>;
  longFlagPrefixMap: ReadonlyMap<string, string | null>;
}): string | null {
  if (!params.flag.startsWith("--") || params.flag.length <= 2) {
    return null;
  }
  if (params.knownLongFlagsSet.has(params.flag)) {
    return params.flag;
  }
  return params.longFlagPrefixMap.get(params.flag) ?? null;
}

function consumeLongOptionToken(params: {
  args: string[];
  index: number;
  flag: string;
  inlineValue: string | undefined;
  allowedValueFlags: ReadonlySet<string>;
  deniedFlags: ReadonlySet<string>;
  knownLongFlagsSet: ReadonlySet<string>;
  longFlagPrefixMap: ReadonlyMap<string, string | null>;
}): number {
  const canonicalFlag = resolveCanonicalLongFlag({
    flag: params.flag,
    knownLongFlagsSet: params.knownLongFlagsSet,
    longFlagPrefixMap: params.longFlagPrefixMap,
  });
  if (!canonicalFlag) {
    return -1;
  }
  if (params.deniedFlags.has(canonicalFlag)) {
    return -1;
  }
  const expectsValue = params.allowedValueFlags.has(canonicalFlag);
  if (params.inlineValue !== undefined) {
    if (!expectsValue) {
      return -1;
    }
    return isSafeLiteralToken(params.inlineValue) ? params.index + 1 : -1;
  }
  if (!expectsValue) {
    return params.index + 1;
  }
  return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
}

function consumeShortOptionClusterToken(params: {
  args: string[];
  index: number;
  cluster: string;
  flags: string[];
  allowedValueFlags: ReadonlySet<string>;
  deniedFlags: ReadonlySet<string>;
}): number {
  // Profiles that declare at least one denied or value flag have explicit flag
  // awareness. Unknown short options in such profiles are treated as harmless
  // boolean flags (e.g. `wc -l` where only `--files0-from` is denied).
  // Profiles without any flag declarations reject ALL short options to stay
  // fail-closed (e.g. `tr` only expects positional arguments).
  const profileHasFlagAwareness = params.allowedValueFlags.size > 0 || params.deniedFlags.size > 0;
  for (let j = 0; j < params.flags.length; j += 1) {
    const flag = params.flags[j];
    if (params.deniedFlags.has(flag)) {
      return -1;
    }
    if (!params.allowedValueFlags.has(flag)) {
      if (!profileHasFlagAwareness) {
        return -1;
      }
      continue;
    }
    const inlineValue = params.cluster.slice(j + 1);
    if (inlineValue) {
      return isSafeLiteralToken(inlineValue) ? params.index + 1 : -1;
    }
    return isInvalidValueToken(params.args[params.index + 1]) ? -1 : params.index + 2;
  }
  return params.flags.length > 0 && profileHasFlagAwareness ? params.index + 1 : -1;
}

function consumePositionalToken(token: string, positional: string[]): boolean {
  if (!isSafeLiteralToken(token)) {
    return false;
  }
  // Shell expansion tokens (e.g. $FOO, ${BAR}) are not counted as positionals
  // because the enforced command single-quotes all tokens, neutralizing expansion.
  // After enforcement `$FOO` becomes the literal string '$FOO', not a file path.
  if (hasShellExpansion(token)) {
    return true;
  }
  positional.push(token);
  return true;
}

function validatePositionalCount(positional: string[], profile: SafeBinProfile): boolean {
  const minPositional = profile.minPositional ?? 0;
  if (positional.length < minPositional) {
    return false;
  }
  return typeof profile.maxPositional !== "number" || positional.length <= profile.maxPositional;
}

export function validateSafeBinArgv(args: string[], profile: SafeBinProfile): boolean {
  const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
  const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
  const knownLongFlags =
    profile.knownLongFlags ?? collectKnownLongFlags(allowedValueFlags, deniedFlags);
  const knownLongFlagsSet = profile.knownLongFlagsSet ?? new Set(knownLongFlags);
  const longFlagPrefixMap = profile.longFlagPrefixMap ?? buildLongFlagPrefixMap(knownLongFlags);

  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const rawToken = args[i] ?? "";
    const token = parseExecArgvToken(rawToken);

    if (token.kind === "empty" || token.kind === "stdin") {
      i += 1;
      continue;
    }

    if (token.kind === "terminator") {
      for (let j = i + 1; j < args.length; j += 1) {
        const rest = args[j];
        if (!rest || rest === "-") {
          continue;
        }
        if (!consumePositionalToken(rest, positional)) {
          return false;
        }
      }
      break;
    }

    if (token.kind === "positional") {
      if (!consumePositionalToken(token.raw, positional)) {
        return false;
      }
      i += 1;
      continue;
    }

    if (token.style === "long") {
      const nextIndex = consumeLongOptionToken({
        args,
        index: i,
        flag: token.flag,
        inlineValue: token.inlineValue,
        allowedValueFlags,
        deniedFlags,
        knownLongFlagsSet,
        longFlagPrefixMap,
      });
      if (nextIndex < 0) {
        return false;
      }
      i = nextIndex;
      continue;
    }

    const nextIndex = consumeShortOptionClusterToken({
      args,
      index: i,
      cluster: token.cluster,
      flags: token.flags,
      allowedValueFlags,
      deniedFlags,
    });
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  return validatePositionalCount(positional, profile);
}
