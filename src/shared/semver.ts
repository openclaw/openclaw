type ComparableSemver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[] | null;
};

export function compareSemverStrings(a: string | null, b: string | null): number | null {
  const pa = parseComparableSemver(a);
  const pb = parseComparableSemver(b);
  if (!pa || !pb) {
    return null;
  }
  if (pa.major !== pb.major) {
    return pa.major < pb.major ? -1 : 1;
  }
  if (pa.minor !== pb.minor) {
    return pa.minor < pb.minor ? -1 : 1;
  }
  if (pa.patch !== pb.patch) {
    return pa.patch < pb.patch ? -1 : 1;
  }
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

function parseComparableSemver(version: string | null): ComparableSemver | null {
  if (!version) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(version.trim());
  const match = /^v?([0-9]+)\.([0-9]+)\.([0-9]+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    normalized,
  );
  if (!match) {
    return null;
  }
  const [, major, minor, patch, prereleaseRaw] = match;
  if (!major || !minor || !patch) {
    return null;
  }
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
    prerelease: prereleaseRaw ? prereleaseRaw.split(".").filter(Boolean) : null,
  };
}

function normalizeLegacyDotBetaVersion(version: string): string {
  const trimmed = version.trim();
  const dotBetaMatch = /^([vV]?[0-9]+\.[0-9]+\.[0-9]+)\.beta(?:\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!dotBetaMatch) {
    return trimmed;
  }
  const base = dotBetaMatch[1];
  const suffix = dotBetaMatch[2];
  return suffix ? `${base}-beta.${suffix}` : `${base}-beta`;
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  if (!a?.length && !b?.length) {
    return 0;
  }
  if (!a?.length) {
    return 1;
  }
  if (!b?.length) {
    return -1;
  }

  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
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

    const aiNumeric = /^[0-9]+$/.test(ai);
    const biNumeric = /^[0-9]+$/.test(bi);
    if (aiNumeric && biNumeric) {
      const aiNum = Number.parseInt(ai, 10);
      const biNum = Number.parseInt(bi, 10);
      return aiNum < biNum ? -1 : 1;
    }
    if (aiNumeric && !biNumeric) {
      return -1;
    }
    if (!aiNumeric && biNumeric) {
      return 1;
    }
    return ai < bi ? -1 : 1;
  }

  return 0;
}
