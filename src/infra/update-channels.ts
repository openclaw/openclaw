export type UpdateChannel = "stable" | "beta" | "dev";

export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
export const DEV_BRANCH = "main";

export function normalizeUpdateChannel(value?: string | null): UpdateChannel | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") return normalized;
  return null;
}

export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") return "beta";
  if (channel === "dev") return "dev";
  return "latest";
}

export function isBetaTag(tag: string): boolean {
  return tag.toLowerCase().includes("-beta");
}

export function isStableTag(tag: string): boolean {
  return !isBetaTag(tag);
}
