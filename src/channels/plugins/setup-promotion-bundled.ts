/**
 * Doctor-only bundled setup promotion surface lookup.
 *
 * Kept separate so hot Plugin SDK setup helpers never import bundled discovery.
 */
import { getBundledChannelPlugin, hasBundledChannelPackageSetupFeature } from "./bundled.js";
import type { ChannelSetupPromotionSurface } from "./setup-promotion-helpers.js";

export function resolveBundledChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  if (!hasBundledChannelPackageSetupFeature(channelKey, "configPromotion")) {
    return null;
  }
  const setup = getBundledChannelPlugin(channelKey)?.setup;
  return setup && typeof setup === "object" ? setup : null;
}
