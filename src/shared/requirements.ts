export type Requirements = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type RequirementConfigCheck = {
  path: string;
  satisfied: boolean;
};

export type RequirementsMetadata = {
  requires?: Partial<Pick<Requirements, "bins" | "anyBins" | "env" | "config">>;
  os?: string[];
};

export type RequirementRemote = {
  hasBin?: (bin: string) => boolean;
  hasAnyBin?: (bins: string[]) => boolean;
  platforms?: string[];
};

function normalizeOsRequirementPlatform(platform: string): string {
  const normalized = platform.trim().toLowerCase();
  return normalized === "macos" ? "darwin" : normalized;
}

export function isOsRequirementSatisfied(
  required: readonly string[],
  platforms: readonly string[],
): boolean {
  if (required.length === 0) {
    return true;
  }
  const normalizedRequired = new Set(required.map(normalizeOsRequirementPlatform));
  return platforms.some((platform) =>
    normalizedRequired.has(normalizeOsRequirementPlatform(platform)),
  );
}
