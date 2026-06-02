import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { parseComparableSemver } from "./semver-compare.js";

/** Release channel used for package registry and self-update decisions. */
export type UpdateChannel = "stable" | "beta" | "dev";
/** Provenance for the selected update channel shown in status/debug output. */
export type UpdateChannelSource =
  | "config"
  | "git-tag"
  | "git-branch"
  | "installed-version"
  | "default";

/** Package installs default to stable unless config or beta-version state says otherwise. */
export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
/** Git checkouts default to dev because branch installs usually track unreleased code. */
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
/** Branch name treated as the canonical development stream for git installs. */
export const DEV_BRANCH = "main";

/** Normalize user/config channel text to the supported update channels. */
export function normalizeUpdateChannel(value?: string | null): UpdateChannel | null {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return null;
  }
  if (normalized === "stable" || normalized === "beta" || normalized === "dev") {
    return normalized;
  }
  return null;
}

/** Map OpenClaw update channels onto npm dist-tags. */
export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") {
    return "beta";
  }
  if (channel === "dev") {
    return "dev";
  }
  return "latest";
}

/** Detect OpenClaw beta tags without treating words like "alphabeta" as beta releases. */
export function isBetaTag(tag: string): boolean {
  return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}

/** Classify semantic prereleases, with a regex fallback for legacy/non-semver tags. */
export function isPrereleaseTag(tag: string): boolean {
  const parsed = parseComparableSemver(tag, { normalizeLegacyDotBeta: true });
  if (parsed) {
    return Boolean(parsed.prerelease?.some((part) => !/^[0-9]+$/.test(part)));
  }
  return /(?:^|[.-])(alpha|beta|rc|pre|preview|canary|dev|next|nightly|experimental)(?:[.-]|$)/i.test(
    tag,
  );
}

/** True only for tags that should track the stable channel. */
export function isStableTag(tag: string): boolean {
  return !isPrereleaseTag(tag);
}

/** Resolve the npm registry channel, preserving beta when the installed version is beta. */
export function resolveRegistryUpdateChannel(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
}): UpdateChannel {
  if (
    params.currentVersion &&
    isBetaTag(params.currentVersion) &&
    params.configChannel !== "beta" &&
    params.configChannel !== "dev"
  ) {
    // Beta installs should keep receiving beta-compatible plugin/package targets.
    return "beta";
  }
  return params.configChannel ?? DEFAULT_PACKAGE_CHANNEL;
}

/** Resolve the effective channel plus the evidence that selected it. */
export function resolveEffectiveUpdateChannel(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
  installKind: "git" | "package" | "unknown";
  git?: { tag?: string | null; branch?: string | null };
}): { channel: UpdateChannel; source: UpdateChannelSource } {
  if (
    params.currentVersion &&
    isBetaTag(params.currentVersion) &&
    params.configChannel !== "beta" &&
    params.configChannel !== "dev"
  ) {
    // A beta install should not silently downgrade to stable because of stale config.
    return { channel: "beta", source: "installed-version" };
  }

  if (params.configChannel) {
    return { channel: params.configChannel, source: "config" };
  }

  if (params.installKind === "git") {
    const tag = params.git?.tag;
    if (tag) {
      // Git tags carry stronger release-channel evidence than detached branch state.
      return {
        channel: isBetaTag(tag) ? "beta" : isStableTag(tag) ? "stable" : "dev",
        source: "git-tag",
      };
    }
    const branch = params.git?.branch;
    if (branch && branch !== "HEAD") {
      // Any named branch is treated as dev because it can advance outside npm releases.
      return { channel: "dev", source: "git-branch" };
    }
    return { channel: DEFAULT_GIT_CHANNEL, source: "default" };
  }

  if (params.installKind === "package") {
    return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
  }

  return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
}

/** Format channel/source pairs for user-facing status and diagnostics. */
export function formatUpdateChannelLabel(params: {
  channel: UpdateChannel;
  source: UpdateChannelSource;
  gitTag?: string | null;
  gitBranch?: string | null;
}): string {
  if (params.source === "config") {
    return `${params.channel} (config)`;
  }
  if (params.source === "git-tag") {
    return params.gitTag ? `${params.channel} (${params.gitTag})` : `${params.channel} (tag)`;
  }
  if (params.source === "git-branch") {
    return params.gitBranch
      ? `${params.channel} (${params.gitBranch})`
      : `${params.channel} (branch)`;
  }
  if (params.source === "installed-version") {
    return "beta (installed version)";
  }
  return `${params.channel} (default)`;
}

/** Resolve update channel, provenance, and display label in one call. */
export function resolveUpdateChannelDisplay(params: {
  configChannel?: UpdateChannel | null;
  currentVersion?: string | null;
  installKind: "git" | "package" | "unknown";
  gitTag?: string | null;
  gitBranch?: string | null;
}): { channel: UpdateChannel; source: UpdateChannelSource; label: string } {
  const channelInfo = resolveEffectiveUpdateChannel({
    configChannel: params.configChannel,
    currentVersion: params.currentVersion,
    installKind: params.installKind,
    git:
      params.gitTag || params.gitBranch
        ? { tag: params.gitTag ?? null, branch: params.gitBranch ?? null }
        : undefined,
  });
  return {
    channel: channelInfo.channel,
    source: channelInfo.source,
    label: formatUpdateChannelLabel({
      channel: channelInfo.channel,
      source: channelInfo.source,
      gitTag: params.gitTag ?? null,
      gitBranch: params.gitBranch ?? null,
    }),
  };
}
