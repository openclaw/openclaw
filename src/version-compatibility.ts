// This extended-stable release contains the signed v2026.11.4 source baseline.
// Runtime admission and synthetic successor fixtures share this exact API identity.
export function resolveReleaseCompatibilityVersion(releaseVersion: string): string {
  return releaseVersion === "2026.10.33" ? "2026.11.4" : releaseVersion;
}
