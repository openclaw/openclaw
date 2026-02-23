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
  allowedValueFlags?: ReadonlySet<string>;
  deniedFlags?: ReadonlySet<string>;
};

export type SafeBinProfileFixture = {
  minPositional?: number;
  maxPositional?: number;
  allowedValueFlags?: readonly string[];
  deniedFlags?: readonly string[];
};

export type SafeBinProfileFixtures = Readonly<Record<string, SafeBinProfileFixture>>;

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
    allowedValueFlags: toFlagSet(fixture.allowedValueFlags),
    deniedFlags: toFlagSet(fixture.deniedFlags),
  };
}

function compileSafeBinProfiles(
  fixtures: Record<string, SafeBinProfileFixture>,
): Record<string, SafeBinProfile> {
  return Object.fromEntries(
    Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]),
  ) as Record<string, SafeBinProfile>;
}

export const SAFE_BIN_PROFILE_FIXTURES: Record<string, SafeBinProfileFixture> = {
  jq: {
    maxPositional: 1,
    allowedValueFlags: ["--arg", "--argjson", "--argstr"],
    deniedFlags: [
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
    // Keep grep stdin-only: pattern must come from -e/--regexp.
    // Allowing one positional is ambiguous because -e consumes the pattern and
    // frees the positional slot for a filename.
    maxPositional: 0,
    allowedValueFlags: [
      "--regexp",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--devices",
      "--binary-files",
      "--exclude",
      "--include",
      "--label",
      "-e",
      "-m",
      "-A",
      "-B",
      "-C",
      "-D",
    ],
    deniedFlags: [
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
    allowedValueFlags: [
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
    allowedValueFlags: [
      "--key",
      "--field-separator",
      "--buffer-size",
      "--parallel",
      "--batch-size",
      "-k",
      "-t",
      "-S",
    ],
    // --compress-program can invoke an external executable and breaks stdin-only guarantees.
    // --random-source/--temporary-directory/-T are filesystem-dependent and not stdin-only.
    deniedFlags: [
      "--compress-program",
      "--files0-from",
      "--output",
      "--random-source",
      "--temporary-directory",
      "-T",
      "-o",
    ],
  },
  uniq: {
    maxPositional: 0,
    allowedValueFlags: [
      "--skip-fields",
      "--skip-chars",
      "--check-chars",
      "--group",
      "-f",
      "-s",
      "-w",
    ],
  },
  head: {
    maxPositional: 0,
    allowedValueFlags: ["--lines", "--bytes", "-n", "-c"],
  },
  tail: {
    maxPositional: 0,
    allowedValueFlags: [
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
    deniedFlags: ["--files0-from"],
  },
};

export const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> =
  compileSafeBinProfiles(SAFE_BIN_PROFILE_FIXTURES);

function normalizeSafeBinProfileName(raw: string): string | null {
  const name = raw.trim().toLowerCase();
  return name.length > 0 ? name : null;
}

function normalizeFixtureLimit(raw: number | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return undefined;
  }
  const next = Math.trunc(raw);
  return next >= 0 ? next : undefined;
}

function normalizeFixtureFlags(
  flags: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!Array.isArray(flags) || flags.length === 0) {
    return undefined;
  }
  const normalized = Array.from(
    new Set(flags.map((flag) => flag.trim()).filter((flag) => flag.length > 0)),
  ).toSorted((a, b) => a.localeCompare(b));
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSafeBinProfileFixture(fixture: SafeBinProfileFixture): SafeBinProfileFixture {
  const minPositional = normalizeFixtureLimit(fixture.minPositional);
  const maxPositionalRaw = normalizeFixtureLimit(fixture.maxPositional);
  const maxPositional =
    minPositional !== undefined &&
    maxPositionalRaw !== undefined &&
    maxPositionalRaw < minPositional
      ? minPositional
      : maxPositionalRaw;
  return {
    minPositional,
    maxPositional,
    allowedValueFlags: normalizeFixtureFlags(fixture.allowedValueFlags),
    deniedFlags: normalizeFixtureFlags(fixture.deniedFlags),
  };
}

export function normalizeSafeBinProfileFixtures(
  fixtures?: SafeBinProfileFixtures | null,
): Record<string, SafeBinProfileFixture> {
  const normalized: Record<string, SafeBinProfileFixture> = {};
  if (!fixtures) {
    return normalized;
  }
  for (const [rawName, fixture] of Object.entries(fixtures)) {
    const name = normalizeSafeBinProfileName(rawName);
    if (!name) {
      continue;
    }
    normalized[name] = normalizeSafeBinProfileFixture(fixture);
  }
  return normalized;
}

export function resolveSafeBinProfiles(
  fixtures?: SafeBinProfileFixtures | null,
): Record<string, SafeBinProfile> {
  const normalizedFixtures = normalizeSafeBinProfileFixtures(fixtures);
  if (Object.keys(normalizedFixtures).length === 0) {
    return SAFE_BIN_PROFILES;
  }
  return {
    ...SAFE_BIN_PROFILES,
    ...compileSafeBinProfiles(normalizedFixtures),
  };
}

export function resolveSafeBinDeniedFlags(
  fixtures: Readonly<Record<string, SafeBinProfileFixture>> = SAFE_BIN_PROFILE_FIXTURES,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const denied = Array.from(new Set(fixture.deniedFlags ?? [])).toSorted();
    if (denied.length > 0) {
      out[name] = denied;
    }
  }
  return out;
}

export function renderSafeBinDeniedFlagsDocBullets(
  fixtures: Readonly<Record<string, SafeBinProfileFixture>> = SAFE_BIN_PROFILE_FIXTURES,
): string {
  const deniedByBin = resolveSafeBinDeniedFlags(fixtures);
  const bins = Object.keys(deniedByBin).toSorted();
  return bins
    .map((bin) => `- \`${bin}\`: ${deniedByBin[bin].map((flag) => `\`${flag}\``).join(", ")}`)
    .join("\n");
}

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function isInvalidValueToken(value: string | undefined): boolean {
  return !value || !isSafeLiteralToken(value);
}

function collectKnownLongFlags(
  allowedValueFlags: ReadonlySet<string>,
  deniedFlags: ReadonlySet<string>,
): string[] {
  const known = new Set<string>();
  for (const flag of allowedValueFlags) {
    if (flag.startsWith("--")) {
      known.add(flag);
    }
  }
  for (const flag of deniedFlags) {
    if (flag.startsWith("--")) {
      known.add(flag);
    }
  }
  return Array.from(known);
}

function resolveCanonicalLongFlag(flag: string, knownLongFlags: string[]): string | null {
  if (!flag.startsWith("--") || flag.length <= 2) {
    return null;
  }
  if (knownLongFlags.includes(flag)) {
    return flag;
  }
  const matches = knownLongFlags.filter((candidate) => candidate.startsWith(flag));
  if (matches.length !== 1) {
    return null;
  }
  return matches[0] ?? null;
}

function consumeLongOptionToken(
  args: string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
  allowedValueFlags: ReadonlySet<string>,
  deniedFlags: ReadonlySet<string>,
): number {
  const knownLongFlags = collectKnownLongFlags(allowedValueFlags, deniedFlags);
  const canonicalFlag = resolveCanonicalLongFlag(flag, knownLongFlags);
  if (!canonicalFlag) {
    return -1;
  }
  if (deniedFlags.has(canonicalFlag)) {
    return -1;
  }
  const expectsValue = allowedValueFlags.has(canonicalFlag);
  if (inlineValue !== undefined) {
    if (!expectsValue) {
      return -1;
    }
    return isSafeLiteralToken(inlineValue) ? index + 1 : -1;
  }
  if (!expectsValue) {
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
  allowedValueFlags: ReadonlySet<string>,
  deniedFlags: ReadonlySet<string>,
): number {
  for (let j = 0; j < flags.length; j += 1) {
    const flag = flags[j];
    if (deniedFlags.has(flag)) {
      return -1;
    }
    if (!allowedValueFlags.has(flag)) {
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
  const allowedValueFlags = profile.allowedValueFlags ?? NO_FLAGS;
  const deniedFlags = profile.deniedFlags ?? NO_FLAGS;
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
        allowedValueFlags,
        deniedFlags,
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
      allowedValueFlags,
      deniedFlags,
    );
    if (nextIndex < 0) {
      return false;
    }
    i = nextIndex;
  }

  return validatePositionalCount(positional, profile);
}
