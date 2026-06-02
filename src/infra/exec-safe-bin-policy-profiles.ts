import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";

/** Compiled runtime policy for one safe-bin executable. */
export type SafeBinProfile = {
  /** Minimum number of literal positional tokens the safe-bin command requires. */
  minPositional?: number;
  /** Maximum number of literal positional tokens allowed after option parsing. */
  maxPositional?: number;
  /** Flags that are allowed only when followed by a safe literal value. */
  allowedValueFlags?: ReadonlySet<string>;
  /** Flags that always make the safe-bin invocation unsafe. */
  deniedFlags?: ReadonlySet<string>;
  // Precomputed long-option metadata for GNU abbreviation resolution.
  knownLongFlags?: readonly string[];
  knownLongFlagsSet?: ReadonlySet<string>;
  longFlagPrefixMap?: ReadonlyMap<string, string | null>;
};

/** JSON-safe profile shape used for config overlays and docs parity fixtures. */
export type SafeBinProfileFixture = {
  /** JSON-friendly minimum positional-token count. */
  minPositional?: number;
  /** JSON-friendly maximum positional-token count. */
  maxPositional?: number;
  /** JSON-friendly flags that consume safe literal values. */
  allowedValueFlags?: readonly string[];
  /** JSON-friendly flags that are never safe for this command family. */
  deniedFlags?: readonly string[];
};

/** Operator-provided safe-bin profile fixtures keyed by normalized executable name. */
export type SafeBinProfileFixtures = Readonly<Record<string, SafeBinProfileFixture>>;

const NO_FLAGS: ReadonlySet<string> = new Set();

/** Built-in stdin-only commands enabled when no safeBins override is configured. */
export const DEFAULT_SAFE_BINS = ["cut", "uniq", "head", "tail", "tr", "wc"] as const;

const toFlagSet = (flags?: readonly string[]): ReadonlySet<string> => {
  if (!flags || flags.length === 0) {
    return NO_FLAGS;
  }
  return new Set(flags);
};

/** Collects long options known to the profile for abbreviation resolution. */
export function collectKnownLongFlags(
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

/** Maps unambiguous GNU long-option prefixes to their canonical full flag. */
export function buildLongFlagPrefixMap(
  knownLongFlags: readonly string[],
): ReadonlyMap<string, string | null> {
  const prefixMap = new Map<string, string | null>();
  for (const flag of knownLongFlags) {
    if (!flag.startsWith("--") || flag.length <= 2) {
      continue;
    }
    for (let length = 3; length <= flag.length; length += 1) {
      const prefix = flag.slice(0, length);
      const existing = prefixMap.get(prefix);
      if (existing === undefined) {
        prefixMap.set(prefix, flag);
        continue;
      }
      if (existing !== flag) {
        prefixMap.set(prefix, null);
      }
    }
  }
  return prefixMap;
}

function compileSafeBinProfile(fixture: SafeBinProfileFixture): SafeBinProfile {
  const allowedValueFlags = toFlagSet(fixture.allowedValueFlags);
  const deniedFlags = toFlagSet(fixture.deniedFlags);
  const knownLongFlags = collectKnownLongFlags(allowedValueFlags, deniedFlags);
  return {
    minPositional: fixture.minPositional,
    maxPositional: fixture.maxPositional,
    allowedValueFlags,
    deniedFlags,
    knownLongFlags,
    knownLongFlagsSet: new Set(knownLongFlags),
    longFlagPrefixMap: buildLongFlagPrefixMap(knownLongFlags),
  };
}

function compileSafeBinProfiles(
  fixtures: Record<string, SafeBinProfileFixture>,
): Record<string, SafeBinProfile> {
  return Object.fromEntries(
    Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]),
  ) as Record<string, SafeBinProfile>;
}

/**
 * Built-in stdin-only safe-bin policy fixtures.
 *
 * These stay JSON-friendly so docs parity tests and operator overrides share the same shape.
 */
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

/** Compiled built-in safe-bin profiles used by runtime argv validation. */
export const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> =
  compileSafeBinProfiles(SAFE_BIN_PROFILE_FIXTURES);

function normalizeSafeBinProfileName(raw: string): string | null {
  const name = normalizeLowercaseStringOrEmpty(raw);
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

/**
 * Normalizes operator-provided profile fixtures into deterministic JSON shape.
 *
 * Invalid names, negative limits, duplicate flags, and empty flag entries are dropped before the
 * fixtures are persisted or compiled into runtime profiles.
 */
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

/**
 * Resolves runtime profiles by overlaying normalized fixtures on built-ins.
 *
 * Operator fixtures replace the matching built-in command profile; commands without overrides keep
 * the compiled defaults.
 */
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

function resolveSafeBinDeniedFlags(
  fixtures: Readonly<Record<string, SafeBinProfileFixture>> = SAFE_BIN_PROFILE_FIXTURES,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const denied = sortUniqueStrings(fixture.deniedFlags ?? []);
    if (denied.length > 0) {
      out[name] = denied;
    }
  }
  return out;
}

/** Renders denied safe-bin flags for docs parity checks and generated documentation blocks. */
export function renderSafeBinDeniedFlagsDocBullets(
  fixtures: Readonly<Record<string, SafeBinProfileFixture>> = SAFE_BIN_PROFILE_FIXTURES,
): string {
  const deniedByBin = resolveSafeBinDeniedFlags(fixtures);
  const bins = Object.keys(deniedByBin).toSorted();
  return bins
    .map((bin) => `- \`${bin}\`: ${deniedByBin[bin].map((flag) => `\`${flag}\``).join(", ")}`)
    .join("\n");
}

/** Renders default safe-bin names for docs parity checks and generated documentation blocks. */
export function renderDefaultSafeBinsDocText(
  defaults: readonly string[] = DEFAULT_SAFE_BINS,
): string {
  return defaults.map((bin) => `\`${bin}\``).join(", ");
}
