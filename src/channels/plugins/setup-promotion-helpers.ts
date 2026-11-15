import { getLoadedChannelPluginForRead } from "./registry-loaded.js";
import type { ChannelSetupAdapter } from "./setup-adapter.types.js";

/**
 * Common root-level channel config keys safe to promote into a single account.
 */
const COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  "name",
  "token",
  "tokenFile",
  // Tencent's out-of-tree @wecom/wecom-openclaw-plugin still writes root
  // botId/secret. Keep promoting them until WeCom publishes plugin declarations.
  "botId",
  "secret",
  "botToken",
  "webhookPath",
  "webhookUrl",
  "dmPolicy",
  "allowFrom",
  "groupPolicy",
  "groupAllowFrom",
  "defaultTo",
] as const;

/**
 * Setup-only config keys that can move during single-account migration.
 */
const SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS = [
  ...COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS,
  "streaming",
  "allowBots",
  "blockStreaming",
  "replyToMode",
  "textChunkLimit",
  "chunkMode",
  "responsePrefix",
  "ackReaction",
  "ackReactionScope",
  "reactionNotifications",
  "threadBindings",
  "mediaMaxMb",
  "dm",
  "groups",
  "actions",
] as const;

const commonSingleAccountPromotionKeys = new Set<string>(COMMON_SINGLE_ACCOUNT_PROMOTION_KEYS);
const setupSingleAccountPromotionKeys = new Set<string>(SETUP_SINGLE_ACCOUNT_PROMOTION_KEYS);

export type ChannelSetupPromotionSurface = Pick<
  ChannelSetupAdapter,
  | "accountKeyPolicy"
  | "configPromotion"
  | "singleAccountKeysToMove"
  | "namedAccountPromotionKeys"
  | "resolveSingleAccountPromotionTarget"
>;

type SingleAccountPromotion =
  | { kind: "preserve-root" }
  | { kind: "promote"; keysToMove: string[]; shouldDeferPromotion: boolean };

// Published undeclared adapters still depend on these keys: Chatu, GroupMe, OneBot,
// and WhatsApp Cloud use accessToken; Claworld uses appToken; OneBot uses httpUrl;
// MQTT and TrueConf use password; Rocket.Chat uses rooms and userId; WorkClaw and
// TIMBot use userId; Vama, Pinto, and Roam use webhookSecret (2026-07-22 sweep).
// Delete each key as soon as no published plugin reads it; no version boundary is needed.
const LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS = {
  common: ["accessToken", "appToken", "httpUrl", "password", "userId", "webhookSecret"],
  setupOnly: ["rooms"],
} as const;

const legacyUndeclaredAdapterCommonPromotionKeys = new Set<string>(
  LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS.common,
);
const legacyUndeclaredAdapterSetupOnlyPromotionKeys = new Set<string>(
  LEGACY_UNDECLARED_ADAPTER_PROMOTION_KEYS.setupOnly,
);

function hasPromotionDeclarations(surface: ChannelSetupPromotionSurface | null): boolean {
  return Boolean(surface && Object.hasOwn(surface, "singleAccountKeysToMove"));
}

function isLegacyUndeclaredAdapterPromotionKey(key: string, includeSetupKeys: boolean): boolean {
  return (
    legacyUndeclaredAdapterCommonPromotionKeys.has(key) ||
    (includeSetupKeys && legacyUndeclaredAdapterSetupOnlyPromotionKeys.has(key))
  );
}

function asPromotionSurface(setup: unknown): ChannelSetupPromotionSurface | null {
  return setup && typeof setup === "object" ? (setup as ChannelSetupPromotionSurface) : null;
}

function getLoadedChannelSetupPromotionSurface(
  channelKey: string,
): ChannelSetupPromotionSurface | null {
  const plugin = getLoadedChannelPluginForRead(channelKey);
  return asPromotionSurface(plugin?.setupContract ?? plugin?.setup);
}

/**
 * Resolves all root-level keys eligible for single-account promotion.
 */
export function resolveSingleAccountPromotion(params: {
  channelKey: string;
  channel: Record<string, unknown>;
  setupSurface?: ChannelSetupPromotionSurface;
  includeSetupKeys?: boolean;
  resolveBundledSurface?: (channelKey: string) => ChannelSetupPromotionSurface | null;
}): SingleAccountPromotion {
  const setupSurface =
    params.setupSurface === undefined
      ? (getLoadedChannelSetupPromotionSurface(params.channelKey) ??
        params.resolveBundledSurface?.(params.channelKey) ??
        null)
      : asPromotionSurface(params.setupSurface);
  // Generic policy fields also belong to a preserved root identity.
  if (setupSurface?.configPromotion === "preserve-root") {
    return { kind: "preserve-root" };
  }
  const channel = params.channel;
  const hasNamedAccounts = Object.keys(channel.accounts ?? {}).some(Boolean);
  const entries = Object.entries(channel)
    .filter(
      ([key, value]) =>
        key !== "accounts" && key !== "defaultAccount" && key !== "enabled" && value !== undefined,
    )
    .map(([key]) => key);
  if (entries.length === 0) {
    return { kind: "promote", keysToMove: [], shouldDeferPromotion: false };
  }
  const genericPromotionKeys = params.includeSetupKeys
    ? setupSingleAccountPromotionKeys
    : commonSingleAccountPromotionKeys;
  const isLegacyPromotionKey = (key: string) =>
    isLegacyUndeclaredAdapterPromotionKey(key, params.includeSetupKeys === true);
  const hasUncoveredRootKeys = entries.some(
    (key) => !genericPromotionKeys.has(key) && !isLegacyPromotionKey(key),
  );
  const buildResult = (keysToMove: string[]): SingleAccountPromotion => ({
    kind: "promote",
    keysToMove,
    shouldDeferPromotion: hasUncoveredRootKeys && !hasPromotionDeclarations(setupSurface),
  });

  const keysToMove = entries.filter((key) => {
    if (genericPromotionKeys.has(key)) {
      return true;
    }
    return hasPromotionDeclarations(setupSurface)
      ? Boolean(setupSurface?.singleAccountKeysToMove?.includes(key))
      : isLegacyPromotionKey(key);
  });
  if (!hasNamedAccounts || keysToMove.length === 0) {
    return buildResult(keysToMove);
  }

  // Once named accounts exist, only keys explicitly allowed for named-account
  // promotion should move. This avoids flattening root-only channel settings.
  const namedAccountPromotionKeys = setupSurface?.namedAccountPromotionKeys;
  if (!namedAccountPromotionKeys) {
    return buildResult(keysToMove);
  }
  return buildResult(keysToMove.filter((key) => namedAccountPromotionKeys.includes(key)));
}
