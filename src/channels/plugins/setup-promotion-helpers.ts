/**
 * Channel setup promotion helpers.
 *
 * Moves legacy single-account channel config into account-scoped config records.
 */
import { getBundledChannelPlugin, hasBundledChannelPackageSetupFeature } from "./bundled.js";
import { getLoadedChannelPlugin } from "./registry.js";
import {
  collectSingleAccountPromotionEntries,
  isCommonSingleAccountPromotionKey,
  isSetupSingleAccountPromotionKey,
} from "./setup-promotion-keys.js";

type ChannelSectionBase = {
  defaultAccount?: string;
  accounts?: Record<string, Record<string, unknown>>;
};

type ChannelSetupPromotionSurface = {
  singleAccountKeysToMove?: readonly string[];
  namedAccountPromotionKeys?: readonly string[];
  resolveSingleAccountPromotionTarget?: (params: {
    channel: ChannelSectionBase;
  }) => string | undefined;
};

type SingleAccountPromotionParams = {
  channelKey: string;
  channel: Record<string, unknown>;
  setupSurface?: ChannelSetupPromotionSurface;
  includeSetupKeys?: boolean;
};

function asPromotionSurface(setup: unknown): ChannelSetupPromotionSurface | null {
  return setup && typeof setup === "object" ? (setup as ChannelSetupPromotionSurface) : null;
}

function getLoadedChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  return asPromotionSurface(getLoadedChannelPlugin(channelKey)?.setup);
}

function getBundledChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  if (!hasBundledChannelPackageSetupFeature(channelKey, "configPromotion")) {
    return null;
  }
  return asPromotionSurface(getBundledChannelPlugin(channelKey)?.setup);
}

/**
 * Resolves all root-level keys eligible for single-account promotion.
 */
export function resolveSingleAccountPromotion(params: SingleAccountPromotionParams) {
  const { entries, hasNamedAccounts } = collectSingleAccountPromotionEntries(params.channel);
  const hasPluginOwnedRootKeys = entries.some((key) => !isCommonSingleAccountPromotionKey(key));
  if (entries.length === 0) {
    return { keysToMove: [], hasPluginOwnedRootKeys, hasSetupSurface: false };
  }

  const callerSetupSurface =
    params.setupSurface === undefined ? undefined : asPromotionSurface(params.setupSurface);
  let discoveredSetupSurface: ChannelSetupPromotionSurface | null | undefined;
  const resolveSetupSurface = () => {
    if (callerSetupSurface !== undefined) {
      return callerSetupSurface;
    }
    if (discoveredSetupSurface === undefined) {
      discoveredSetupSurface =
        getLoadedChannelSetupPromotionSurface(params.channelKey) ??
        getBundledChannelSetupPromotionSurface(params.channelKey);
    }
    return discoveredSetupSurface;
  };
  const isGenericPromotionKey = params.includeSetupKeys
    ? isSetupSingleAccountPromotionKey
    : isCommonSingleAccountPromotionKey;

  const keysToMove = entries.filter((key) => {
    if (isGenericPromotionKey(key)) {
      return true;
    }
    return Boolean(resolveSetupSurface()?.singleAccountKeysToMove?.includes(key));
  });
  if (!hasNamedAccounts || keysToMove.length === 0) {
    return {
      keysToMove,
      hasPluginOwnedRootKeys,
      hasSetupSurface: Boolean(callerSetupSurface ?? discoveredSetupSurface),
    };
  }

  // Once named accounts exist, only keys explicitly allowed for named-account
  // promotion should move. This avoids flattening root-only channel settings.
  const namedAccountPromotionKeys = resolveSetupSurface()?.namedAccountPromotionKeys;
  if (!namedAccountPromotionKeys) {
    return { keysToMove, hasPluginOwnedRootKeys, hasSetupSurface: Boolean(resolveSetupSurface()) };
  }
  return {
    keysToMove: keysToMove.filter((key) => namedAccountPromotionKeys.includes(key)),
    hasPluginOwnedRootKeys,
    hasSetupSurface: true,
  };
}

/** Resolves all root-level keys eligible for single-account promotion. */
export function resolveSingleAccountKeysToMove(params: SingleAccountPromotionParams): string[] {
  return resolveSingleAccountPromotion(params).keysToMove;
}
