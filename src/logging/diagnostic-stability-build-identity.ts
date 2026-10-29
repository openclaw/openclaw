export type DiagnosticProcessBuildIdentity = {
  openclawVersion?: string;
  buildId?: string;
  commit?: string;
};

export function readProcessBuildIdentity(source: Record<string, unknown>) {
  const identity: DiagnosticProcessBuildIdentity = {};
  // Preserve SemVer metadata and generated build IDs without importing paths,
  // terminal controls, or unbounded strings from externally supplied bundles.
  for (const [field, pattern] of [
    ["openclawVersion", /^[A-Za-z0-9.+_-]{1,256}$/u],
    ["buildId", /^[A-Za-z0-9._-]{1,96}$/u],
    ["commit", /^[0-9a-f]{7,40}$/iu],
  ] as const) {
    const value = source[field];
    if (typeof value === "string" && pattern.test(value)) {
      identity[field] = value;
    }
  }
  return identity;
}
