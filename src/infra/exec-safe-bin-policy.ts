import { parseExecArgvToken } from "./exec-approvals-analysis.js";

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

export type SafeBinProfileFixture = {
  minPositional?: number;
  maxPositional?: number;
  valueFlags?: readonly string[];
  blockedFlags?: readonly string[];
};

const NO_FLAGS: ReadonlySet<string> = new Set();

const toFlagSet = (flags?: readonly string[]): ReadonlySet<string> => {
  if (!flags || flags.length === 0) {
    return NO_FLAGS;
  }
  return new Set(flags);
};

function compileSafeBinProfile(fixture: SafeBinProfileFixture): SafeBinProfile {
  return {
    minPositional: fixture.minPositional,
    maxPositional: fixture.maxPositional,
    valueFlags: toFlagSet(fixture.valueFlags),
    blockedFlags: toFlagSet(fixture.blockedFlags),
  };
}

function compileSafeBinProfiles(
  fixtures: Record<string, SafeBinProfileFixture>,
): Record<string, SafeBinProfile> {
  return Object.fromEntries(
    Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]),
  ) as Record<string, SafeBinProfile>;
}

export const SAFE_BIN_GENERIC_PROFILE_FIXTURE: SafeBinProfileFixture = {};

export const SAFE_BIN_PROFILE_FIXTURES: Record<string, SafeBinProfileFixture> = {
  jq: {
    maxPositional: 1,
    valueFlags: [
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
    ],
    blockedFlags: [
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ],
  },
  grep: {
    maxPositional: 1,
    valueFlags: [
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
    ],
    blockedFlags: [
      "--file",
      "--exclude-from",
      "--dereference-recursive",
      "--directories",
      "--recursive",
      "-f",
      "-d",
      "-r",
      "-R",
    ],
  },
  cut: {
    maxPositional: 0,
    valueFlags: [
      "--bytes",
      "--characters",
      "--fields",
      "--delimiter",
      "--output-delimiter",
      "-b",
      "-c",
      "-f",
      "-d",
    ],
  },
  sort: {
    maxPositional: 0,
    valueFlags: [
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
    ],
    blockedFlags: ["--files0-from", "--output", "-o"],
  },
  uniq: {
    maxPositional: 0,
    valueFlags: ["--skip-fields", "--skip-chars", "--check-chars", "--group", "-f", "-s", "-w"],
  },
  head: {
    maxPositional: 0,
    valueFlags: ["--lines", "--bytes", "-n", "-c"],
  },
  tail: {
    maxPositional: 0,
    valueFlags: [
      "--lines",
      "--bytes",
      "--sleep-interval",
      "--max-unchanged-stats",
      "--pid",
      "-n",
      "-c",
    ],
  },
  tr: {
    minPositional: 1,
    maxPositional: 2,
  },
  wc: {
    maxPositional: 0,
    valueFlags: ["--files0-from"],
    blockedFlags: ["--files0-from"],
  },
};

export const SAFE_BIN_GENERIC_PROFILE = compileSafeBinProfile(SAFE_BIN_GENERIC_PROFILE_FIXTURE);

export const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> =
  compileSafeBinProfiles(SAFE_BIN_PROFILE_FIXTURES);

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function isInvalidValueToken(value: string | undefined): boolean {
  return !value || !isSafeLiteralToken(value);
}

function consumeLongOptionToken(
  args: string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
  valueFlags: ReadonlySet<string>,
  blockedFlags: ReadonlySet<string>,
): number {
  if (blockedFlags.has(flag)) {
    return -1;
  }
  if (inlineValue !== undefined) {
    return isSafeLiteralToken(inlineValue) ? index + 1 : -1;
  }
  if (!valueFlags.has(flag)) {
    return index + 1;
  }
  return isInvalidValueToken(args[index + 1]) ? -1 : index + 2;
}

function consumeShortOptionClusterToken(
  args: string[],
  index: number,
  raw: string,
  cluster: string,
  flags: string[],
  valueFlags: ReadonlySet<string>,
  blockedFlags: ReadonlySet<string>,
): number {
  for (let j = 0; j < flags.length; j += 1) {
    const flag = flags[j];
    if (blockedFlags.has(flag)) {
      return -1;
    }
    if (!valueFlags.has(flag)) {
      continue;
    }
    const inlineValue = cluster.slice(j + 1);
    if (inlineValue) {
      return isSafeLiteralToken(inlineValue) ? index + 1 : -1;
    }
    return isInvalidValueToken(args[index + 1]) ? -1 : index + 2;
  }
  return hasGlobToken(raw) ? -1 : index + 1;
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
      const nextIndex = consumeLongOptionToken(
        args,
        i,
        token.flag,
        token.inlineValue,
        valueFlags,
        blockedFlags,
      );
      if (nextIndex < 0) {
        return false;
      }
      i = nextIndex;
      continue;
    }

    const nextIndex = consumeShortOptionClusterToken(
      args,
      i,
      token.raw,
      token.cluster,
      token.flags,
      valueFlags,
      blockedFlags,
    );
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  return validatePositionalCount(positional, profile);
}
