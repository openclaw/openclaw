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

export type SafeBinProfile = {
  minPositional?: number;
  maxPositional?: number;
  valueFlags?: ReadonlySet<string>;
  blockedFlags?: ReadonlySet<string>;
};

const NO_FLAGS = new Set<string>();
const asFlagSet = (flags: string[]): ReadonlySet<string> => new Set(flags);

export const SAFE_BIN_GENERIC_PROFILE: SafeBinProfile = {};

export const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> = {
  jq: {
    maxPositional: 1,
    valueFlags: asFlagSet([
      "--arg",
      "--argjson",
      "--argstr",
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
    blockedFlags: asFlagSet([
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
  },
  grep: {
    maxPositional: 1,
    valueFlags: asFlagSet([
      "--regexp",
      "--file",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--devices",
      "--directories",
      "--binary-files",
      "--exclude",
      "--exclude-from",
      "--include",
      "--label",
      "-e",
      "-f",
      "-m",
      "-A",
      "-B",
      "-C",
      "-D",
      "-d",
    ]),
    blockedFlags: asFlagSet([
      "--file",
      "--exclude-from",
      "--dereference-recursive",
      "--directories",
      "--recursive",
      "-f",
      "-d",
      "-r",
      "-R",
    ]),
  },
  cut: {
    maxPositional: 0,
    valueFlags: asFlagSet([
      "--bytes",
      "--characters",
      "--fields",
      "--delimiter",
      "--output-delimiter",
      "-b",
      "-c",
      "-f",
      "-d",
    ]),
  },
  sort: {
    maxPositional: 0,
    valueFlags: asFlagSet([
      "--key",
      "--field-separator",
      "--buffer-size",
      "--temporary-directory",
      "--compress-program",
      "--parallel",
      "--batch-size",
      "--random-source",
      "--files0-from",
      "--output",
      "-k",
      "-t",
      "-S",
      "-T",
      "-o",
    ]),
    blockedFlags: asFlagSet(["--files0-from", "--output", "-o"]),
  },
  uniq: {
    maxPositional: 0,
    valueFlags: asFlagSet([
      "--skip-fields",
      "--skip-chars",
      "--check-chars",
      "--group",
      "-f",
      "-s",
      "-w",
    ]),
  },
  head: {
    maxPositional: 0,
    valueFlags: asFlagSet(["--lines", "--bytes", "-n", "-c"]),
  },
  tail: {
    maxPositional: 0,
    valueFlags: asFlagSet([
      "--lines",
      "--bytes",
      "--sleep-interval",
      "--max-unchanged-stats",
      "--pid",
      "-n",
      "-c",
    ]),
  },
  tr: {
    minPositional: 1,
    maxPositional: 2,
  },
  wc: {
    maxPositional: 0,
    valueFlags: asFlagSet(["--files0-from"]),
    blockedFlags: asFlagSet(["--files0-from"]),
  },
};

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function isInvalidValueToken(value: string | undefined): boolean {
  return !value || !isSafeLiteralToken(value);
}

function consumeLongFlagToken(
  args: string[],
  index: number,
  valueFlags: ReadonlySet<string>,
  blockedFlags: ReadonlySet<string>,
): number {
  const token = args[index];
  if (!token) {
    return -1;
  }
  const eqIndex = token.indexOf("=");
  const flag = eqIndex > 0 ? token.slice(0, eqIndex) : token;
  if (blockedFlags.has(flag)) {
    return -1;
  }
  if (eqIndex > 0) {
    return isSafeLiteralToken(token.slice(eqIndex + 1)) ? index + 1 : -1;
  }
  if (!valueFlags.has(flag)) {
    return index + 1;
  }
  return isInvalidValueToken(args[index + 1]) ? -1 : index + 2;
}

function consumeShortFlagClusterToken(
  args: string[],
  index: number,
  valueFlags: ReadonlySet<string>,
  blockedFlags: ReadonlySet<string>,
): number {
  const token = args[index];
  if (!token) {
    return -1;
  }
  for (let j = 1; j < token.length; j += 1) {
    const flag = `-${token[j]}`;
    if (blockedFlags.has(flag)) {
      return -1;
    }
    if (!valueFlags.has(flag)) {
      continue;
    }
    const inlineValue = token.slice(j + 1);
    if (inlineValue) {
      return isSafeLiteralToken(inlineValue) ? index + 1 : -1;
    }
    return isInvalidValueToken(args[index + 1]) ? -1 : index + 2;
  }
  return hasGlobToken(token) ? -1 : index + 1;
}

function consumePositionalToken(token: string, positional: string[]): boolean {
  if (!isSafeLiteralToken(token)) {
    return false;
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
  const valueFlags = profile.valueFlags ?? NO_FLAGS;
  const blockedFlags = profile.blockedFlags ?? NO_FLAGS;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const token = args[i];
    if (!token) {
      i += 1;
      continue;
    }
    if (token === "--") {
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
    if (token === "-") {
      i += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (!consumePositionalToken(token, positional)) {
        return false;
      }
      i += 1;
      continue;
    }

    if (token.startsWith("--")) {
      const nextIndex = consumeLongFlagToken(args, i, valueFlags, blockedFlags);
      if (nextIndex < 0) {
        return false;
      }
      i = nextIndex;
      continue;
    }

    const nextIndex = consumeShortFlagClusterToken(args, i, valueFlags, blockedFlags);
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  return validatePositionalCount(positional, profile);
}
