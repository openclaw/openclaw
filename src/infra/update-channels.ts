import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

export type UpdateChannel = "stable" | "beta" | "dev";
export type UpdateChannelSource =
  | "config"
  | "git-tag"
  | "git-branch"
  | "installed-version"
  | "default";

export const DEFAULT_PACKAGE_CHANNEL: UpdateChannel = "stable";
export const DEFAULT_GIT_CHANNEL: UpdateChannel = "dev";
export const DEV_BRANCH = "main";
export const DEFAULT_NPM_REGISTRY_URL = "https://registry.npmjs.org";

const NPM_REGISTRY_ENV_KEYS = [
  "npm_config_registry",
  "NPM_CONFIG_REGISTRY",
  "npm_config_userconfig_registry",
] as const;

function normalizeNpmRegistryBaseUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

export function resolveNpmRegistryBaseUrl(
  env: Partial<Record<(typeof NPM_REGISTRY_ENV_KEYS)[number], string | undefined>> = process.env,
): string {
  const configured =
    normalizeOptionalString(env.npm_config_registry) ??
    normalizeOptionalString(env.NPM_CONFIG_REGISTRY) ??
    normalizeOptionalString(env.npm_config_userconfig_registry);
  return (
    normalizeNpmRegistryBaseUrl(configured ?? DEFAULT_NPM_REGISTRY_URL) ?? DEFAULT_NPM_REGISTRY_URL
  );
}

export function resolveNpmPackageTargetRegistryUrl(params: {
  packageName?: string;
  target: string;
  registryBaseUrl?: string;
  env?: Parameters<typeof resolveNpmRegistryBaseUrl>[0];
}): string {
  const registryBaseUrl =
    (params.registryBaseUrl ? normalizeNpmRegistryBaseUrl(params.registryBaseUrl) : null) ??
    resolveNpmRegistryBaseUrl(params.env);
  const packageName = params.packageName ?? "openclaw";
  return `${registryBaseUrl}/${encodeURIComponent(packageName)}/${encodeURIComponent(params.target)}`;
}

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

export function channelToNpmTag(channel: UpdateChannel): string {
  if (channel === "beta") {
    return "beta";
  }
  if (channel === "dev") {
    return "dev";
  }
  return "latest";
}

export function isBetaTag(tag: string): boolean {
  return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}

export function isStableTag(tag: string): boolean {
  return !isBetaTag(tag);
}

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
    return "beta";
  }
  return params.configChannel ?? DEFAULT_PACKAGE_CHANNEL;
}

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
    return { channel: "beta", source: "installed-version" };
  }

  if (params.configChannel) {
    return { channel: params.configChannel, source: "config" };
  }

  if (params.installKind === "git") {
    const tag = params.git?.tag;
    if (tag) {
      return { channel: isBetaTag(tag) ? "beta" : "stable", source: "git-tag" };
    }
    const branch = params.git?.branch;
    if (branch && branch !== "HEAD") {
      return { channel: "dev", source: "git-branch" };
    }
    return { channel: DEFAULT_GIT_CHANNEL, source: "default" };
  }

  if (params.installKind === "package") {
    return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
  }

  return { channel: DEFAULT_PACKAGE_CHANNEL, source: "default" };
}

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
