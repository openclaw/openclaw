const NO_FLAGS = new Set();
const toFlagSet = (flags) => {
    if (!flags || flags.length === 0) {
        return NO_FLAGS;
    }
    return new Set(flags);
};
export function collectKnownLongFlags(allowedValueFlags, deniedFlags) {
    const known = new Set();
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
export function buildLongFlagPrefixMap(knownLongFlags) {
    const prefixMap = new Map();
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
function compileSafeBinProfile(fixture) {
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
function compileSafeBinProfiles(fixtures) {
    return Object.fromEntries(Object.entries(fixtures).map(([name, fixture]) => [name, compileSafeBinProfile(fixture)]));
}
export const SAFE_BIN_PROFILE_FIXTURES = {
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
export const SAFE_BIN_PROFILES = compileSafeBinProfiles(SAFE_BIN_PROFILE_FIXTURES);
function normalizeSafeBinProfileName(raw) {
    const name = raw.trim().toLowerCase();
    return name.length > 0 ? name : null;
}
function normalizeFixtureLimit(raw) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
        return undefined;
    }
    const next = Math.trunc(raw);
    return next >= 0 ? next : undefined;
}
function normalizeFixtureFlags(flags) {
    if (!Array.isArray(flags) || flags.length === 0) {
        return undefined;
    }
    const normalized = Array.from(new Set(flags.map((flag) => flag.trim()).filter((flag) => flag.length > 0))).toSorted((a, b) => a.localeCompare(b));
    return normalized.length > 0 ? normalized : undefined;
}
function normalizeSafeBinProfileFixture(fixture) {
    const minPositional = normalizeFixtureLimit(fixture.minPositional);
    const maxPositionalRaw = normalizeFixtureLimit(fixture.maxPositional);
    const maxPositional = minPositional !== undefined &&
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
export function normalizeSafeBinProfileFixtures(fixtures) {
    const normalized = {};
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
export function resolveSafeBinProfiles(fixtures) {
    const normalizedFixtures = normalizeSafeBinProfileFixtures(fixtures);
    if (Object.keys(normalizedFixtures).length === 0) {
        return SAFE_BIN_PROFILES;
    }
    return {
        ...SAFE_BIN_PROFILES,
        ...compileSafeBinProfiles(normalizedFixtures),
    };
}
export function resolveSafeBinDeniedFlags(fixtures = SAFE_BIN_PROFILE_FIXTURES) {
    const out = {};
    for (const [name, fixture] of Object.entries(fixtures)) {
        const denied = Array.from(new Set(fixture.deniedFlags ?? [])).toSorted();
        if (denied.length > 0) {
            out[name] = denied;
        }
    }
    return out;
}
export function renderSafeBinDeniedFlagsDocBullets(fixtures = SAFE_BIN_PROFILE_FIXTURES) {
    const deniedByBin = resolveSafeBinDeniedFlags(fixtures);
    const bins = Object.keys(deniedByBin).toSorted();
    return bins
        .map((bin) => `- \`${bin}\`: ${deniedByBin[bin].map((flag) => `\`${flag}\``).join(", ")}`)
        .join("\n");
}
