import type { ChannelMeta } from "./types.core.js";

export function resolveChannelExposure(meta: Pick<ChannelMeta, "exposure">) {
  return {
    configured: meta.exposure?.configured ?? true,
    setup: meta.exposure?.setup ?? true,
    docs: meta.exposure?.docs ?? true,
  };
}

export function isChannelVisibleInConfiguredLists(meta: Pick<ChannelMeta, "exposure">): boolean {
  return resolveChannelExposure(meta).configured;
}

export function isChannelVisibleInSetup(meta: Pick<ChannelMeta, "exposure">): boolean {
  return resolveChannelExposure(meta).setup;
}
