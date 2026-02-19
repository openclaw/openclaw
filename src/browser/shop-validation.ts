import type { ShopConfig } from "../config/types.agent-defaults.js";
import { logWarn } from "../logger.js";

export type ShopValidationResult =
  | { ok: true; shopKey: string; config: ShopConfig }
  | { ok: false; error: string; code: "unknown_shop" | "shop_mismatch" | "missing_config" };

/**
 * Resolve a shop config from the shops table.
 * Returns an error result if the shop key is unknown or the config is invalid.
 */
export function resolveShopConfig(
  shops: Record<string, ShopConfig> | undefined,
  shopKey: string,
): ShopValidationResult {
  if (!shops || Object.keys(shops).length === 0) {
    return {
      ok: false,
      error: "No shops configured in agents.defaults.shops",
      code: "missing_config",
    };
  }

  const config = shops[shopKey];
  if (!config) {
    return {
      ok: false,
      error: `unknown_shop: ${shopKey}`,
      code: "unknown_shop",
    };
  }

  // shopCode must be non-empty.
  if (!config.shopCode || config.shopCode.trim().length === 0) {
    return {
      ok: false,
      error: `Shop "${shopKey}" has empty shopCode — config is invalid`,
      code: "missing_config",
    };
  }

  return { ok: true, shopKey, config };
}

/**
 * Validate that the page's shop identity matches the expected config.
 * Uses strict equality (===) — no fuzzy or partial matching.
 */
export function validateShopIdentity(params: {
  shopKey: string;
  config: ShopConfig;
  pageShopName: string;
  pageShopCode: string;
}): ShopValidationResult {
  const { shopKey, config, pageShopName, pageShopCode } = params;

  const nameMatch = config.shopName === pageShopName;
  const codeMatch = config.shopCode === pageShopCode;

  if (nameMatch && codeMatch) {
    return { ok: true, shopKey, config };
  }

  const expected = `shopName="${config.shopName}", shopCode="${config.shopCode}"`;
  const actual = `shopName="${pageShopName}", shopCode="${pageShopCode}"`;
  const error = `shop_mismatch: expected {${expected}}, got {${actual}}`;

  logWarn(`[shop-validation] ${error}`);

  return {
    ok: false,
    error,
    code: "shop_mismatch",
  };
}
