import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export const DEFAULT_PACKAGE_CHANNEL = "stable";
export const DEFAULT_GIT_CHANNEL = "dev";
export const DEV_BRANCH = "main";
export function normalizeUpdateChannel(value) {
    const normalized = normalizeOptionalLowercaseString(value);
    if (!normalized) {
        return null;
    }
    if (normalized === "stable" || normalized === "beta" || normalized === "dev") {
        return normalized;
    }
    return null;
}
export function channelToNpmTag(channel) {
    if (channel === "beta") {
        return "beta";
    }
    if (channel === "dev") {
        return "dev";
    }
    return "latest";
}
export function isBetaTag(tag) {
    return /(?:^|[.-])beta(?:[.-]|$)/i.test(tag);
}
export function isStableTag(tag) {
    return !isBetaTag(tag);
}
export function resolveEffectiveUpdateChannel(params) {
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
export function formatUpdateChannelLabel(params) {
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
    return `${params.channel} (default)`;
}
export function resolveUpdateChannelDisplay(params) {
    const channelInfo = resolveEffectiveUpdateChannel({
        configChannel: params.configChannel,
        installKind: params.installKind,
        git: params.gitTag || params.gitBranch
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
