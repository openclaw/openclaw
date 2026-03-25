/**
 * Lightweight semver range matcher for engine compatibility checks.
 *
 * Supports: >=, >, <=, <, ^, ~, =, * operators and || unions.
 * Does not depend on external `semver` package.
 */

type SemverTuple = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
};

const SEMVER_RE =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemverTuple(version: string): SemverTuple | null {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".").filter(Boolean) : null,
  };
}

/**
 * Compare two semver tuples.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * Prerelease versions are lower than the associated release.
 */
export function compareSemver(a: SemverTuple, b: SemverTuple): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  // No prerelease on either → equal
  if (!a?.length && !b?.length) {
    return 0;
  }
  // Release > prerelease
  if (!a?.length) {
    return 1;
  }
  if (!b?.length) {
    return -1;
  }

  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const ai = a[i];
    const bi = b[i];
    if (ai == null && bi == null) {
      return 0;
    }
    if (ai == null) {
      return -1;
    }
    if (bi == null) {
      return 1;
    }
    if (ai === bi) {
      continue;
    }

    const aiNum = /^[0-9]+$/.test(ai);
    const biNum = /^[0-9]+$/.test(bi);
    if (aiNum && biNum) {
      return Number.parseInt(ai, 10) - Number.parseInt(bi, 10);
    }
    if (aiNum) {
      return -1;
    }
    if (biNum) {
      return 1;
    }
    return ai < bi ? -1 : 1;
  }
  return 0;
}

type Comparator = {
  op: ">=" | ">" | "<=" | "<";
  version: SemverTuple;
};

function satisfiesComparator(version: SemverTuple, cmp: Comparator): boolean {
  const diff = compareSemver(version, cmp.version);
  switch (cmp.op) {
    case ">=":
      return diff >= 0;
    case ">":
      return diff > 0;
    case "<=":
      return diff <= 0;
    case "<":
      return diff < 0;
  }
}

/**
 * Parse a single comparator string (e.g. ">=2026.3.10", "^2026.3.10", "~2026.3.10", "2026.3.10", "*").
 * Returns an array of Comparators that must all be satisfied (AND).
 */
function parseComparators(raw: string): Comparator[] | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "*") {
    return []; // empty = matches everything
  }

  // Operator prefix: >=, >, <=, <, =
  const opMatch = /^(>=|>|<=|<|=)\s*(.+)$/.exec(trimmed);
  if (opMatch) {
    const op = opMatch[1] as ">=" | ">" | "<=" | "<" | "=";
    const ver = parseSemverTuple(opMatch[2]);
    if (!ver) {
      return null;
    }
    if (op === "=") {
      // Exact match: >= and <=
      return [
        { op: ">=", version: ver },
        { op: "<=", version: ver },
      ];
    }
    return [{ op, version: ver }];
  }

  // Caret range: ^MAJOR.MINOR.PATCH
  const caretMatch = /^\^(.+)$/.exec(trimmed);
  if (caretMatch) {
    const ver = parseSemverTuple(caretMatch[1]);
    if (!ver) {
      return null;
    }
    // ^M.m.p → >=M.m.p <(M+1).0.0  (when M > 0)
    // ^0.m.p → >=0.m.p <0.(m+1).0  (when m > 0)
    // ^0.0.p → >=0.0.p <0.0.(p+1)
    let upper: SemverTuple;
    if (ver.major > 0) {
      upper = { major: ver.major + 1, minor: 0, patch: 0, prerelease: null };
    } else if (ver.minor > 0) {
      upper = { major: 0, minor: ver.minor + 1, patch: 0, prerelease: null };
    } else {
      upper = { major: 0, minor: 0, patch: ver.patch + 1, prerelease: null };
    }
    return [
      { op: ">=", version: { ...ver, prerelease: null } },
      { op: "<", version: upper },
    ];
  }

  // Tilde range: ~MAJOR.MINOR.PATCH
  const tildeMatch = /^~(.+)$/.exec(trimmed);
  if (tildeMatch) {
    const ver = parseSemverTuple(tildeMatch[1]);
    if (!ver) {
      return null;
    }
    // ~M.m.p → >=M.m.p <M.(m+1).0
    return [
      { op: ">=", version: { ...ver, prerelease: null } },
      { op: "<", version: { major: ver.major, minor: ver.minor + 1, patch: 0, prerelease: null } },
    ];
  }

  // Bare version: treat as exact
  const ver = parseSemverTuple(trimmed);
  if (!ver) {
    return null;
  }
  return [
    { op: ">=", version: ver },
    { op: "<=", version: ver },
  ];
}

/**
 * Check if a version satisfies a semver range string.
 *
 * Supports operators: >=, >, <=, <, ^, ~, =, *
 * Supports || unions (e.g. ">=2026.3.10 || >=2025.0.0 <2026.0.0").
 * Space-separated comparators within a union branch are AND'd.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const ver = parseSemverTuple(version);
  if (!ver) {
    return false;
  }

  const trimmedRange = range.trim();
  if (!trimmedRange || trimmedRange === "*") {
    return true;
  }

  // Split on || for union branches
  const branches = trimmedRange.split("||");
  for (const branch of branches) {
    if (satisfiesBranch(ver, branch.trim())) {
      return true;
    }
  }
  return false;
}

function satisfiesBranch(version: SemverTuple, branch: string): boolean {
  if (!branch || branch === "*") {
    return true;
  }

  // Split branch into space-separated comparator strings.
  // Each comparator may start with an operator or ^ or ~.
  const parts = tokenizeComparators(branch);
  const allComparators: Comparator[] = [];

  for (const part of parts) {
    const cmps = parseComparators(part);
    if (!cmps) {
      return false;
    } // invalid comparator → branch fails
    allComparators.push(...cmps);
  }

  // All comparators must be satisfied (AND)
  return allComparators.every((cmp) => satisfiesComparator(version, cmp));
}

/**
 * Tokenize a branch string into individual comparator tokens.
 * Handles space-separated comparators like ">=2026.3.10 <2027.0.0".
 */
function tokenizeComparators(branch: string): string[] {
  const tokens: string[] = [];
  // Match tokens that start with an operator/caret/tilde followed by a version,
  // or a bare version.
  const re =
    /(?:>=|>|<=|<|=|\^|~)?\s*v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(branch)) !== null) {
    const token = match[0].trim();
    if (token) {
      tokens.push(token);
    }
  }
  return tokens;
}

/**
 * Sort version strings in descending semver order.
 */
export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].toSorted((a, b) => {
    const pa = parseSemverTuple(a);
    const pb = parseSemverTuple(b);
    if (!pa && !pb) {
      return 0;
    }
    if (!pa) {
      return 1;
    }
    if (!pb) {
      return -1;
    }
    return compareSemver(pb, pa); // descending
  });
}

/**
 * Find the latest version from a list that satisfies the given semver range.
 * Versions should be sorted descending for best performance, but this is not required.
 */
export function findLatestCompatible(versions: string[], range: string): string | null {
  const sorted = sortVersionsDescending(versions);
  for (const v of sorted) {
    if (satisfiesRange(v, range)) {
      return v;
    }
  }
  return null;
}

/**
 * Check if a version string looks like a prerelease (has a hyphen-separated prerelease tag).
 */
export function isPrerelease(version: string): boolean {
  const parsed = parseSemverTuple(version);
  return parsed?.prerelease != null && parsed.prerelease.length > 0;
}
