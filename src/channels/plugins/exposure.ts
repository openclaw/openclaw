import type { ChannelMeta } from "./types.core.js";

/**
 * Resolves modern `exposure` flags with the older top-level visibility flags
 * kept as fallback input for existing channel metadata.
 */
export function resolveChannelExposure(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
) {
  return {
    configured: meta.exposure?.configured ?? meta.showConfigured ?? true,
    setup: meta.exposure?.setup ?? meta.showInSetup ?? true,
    docs: meta.exposure?.docs ?? true,
  };
}

/** Returns whether a channel should appear in configured-channel lists. */
export function isChannelVisibleInConfiguredLists(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return resolveChannelExposure(meta).configured;
}

/** Returns whether a channel should appear in setup/onboarding choices. */
export function isChannelVisibleInSetup(
  meta: Pick<ChannelMeta, "exposure" | "showConfigured" | "showInSetup">,
): boolean {
  return resolveChannelExposure(meta).setup;
}
