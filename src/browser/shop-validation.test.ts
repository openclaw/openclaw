import { describe, expect, it, vi } from "vitest";
import type { ShopConfig } from "../config/types.agent-defaults.js";
import { resolveShopConfig, validateShopIdentity } from "./shop-validation.js";

vi.mock("../logger.js", () => ({
  logWarn: vi.fn(),
}));

const SHOPS: Record<string, ShopConfig> = {
  bigmk: {
    shopName: "bigmk.ph",
    shopCode: "PHLCSLWL2G",
    profile: "tt-3bigmk",
    platform: "tiktok",
  },
  sumifun: {
    shopName: "sumifun.ph",
    shopCode: "PHSUMIFUN1",
    profile: "tt-sumifun",
    platform: "tiktok",
  },
};

describe("resolveShopConfig", () => {
  it("resolves a known shop", () => {
    const result = resolveShopConfig(SHOPS, "bigmk");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.shopName).toBe("bigmk.ph");
      expect(result.config.shopCode).toBe("PHLCSLWL2G");
    }
  });

  it("returns unknown_shop for missing key", () => {
    const result = resolveShopConfig(SHOPS, "nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_shop");
      expect(result.error).toContain("nonexistent");
    }
  });

  it("returns missing_config when shops is undefined", () => {
    const result = resolveShopConfig(undefined, "bigmk");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_config");
    }
  });

  it("returns missing_config when shops is empty", () => {
    const result = resolveShopConfig({}, "bigmk");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_config");
    }
  });

  it("returns missing_config when shopCode is empty string", () => {
    const badShops: Record<string, ShopConfig> = {
      bad: { shopName: "bad.ph", shopCode: "", profile: "tt-bad", platform: "tiktok" },
    };
    const result = resolveShopConfig(badShops, "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_config");
      expect(result.error).toContain("empty shopCode");
    }
  });

  it("returns missing_config when shopCode is whitespace only", () => {
    const badShops: Record<string, ShopConfig> = {
      bad: { shopName: "bad.ph", shopCode: "   ", profile: "tt-bad", platform: "tiktok" },
    };
    const result = resolveShopConfig(badShops, "bad");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("missing_config");
    }
  });
});

describe("validateShopIdentity", () => {
  it("passes when shopName and shopCode match exactly", () => {
    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: SHOPS["bigmk"]!,
      pageShopName: "bigmk.ph",
      pageShopCode: "PHLCSLWL2G",
    });
    expect(result.ok).toBe(true);
  });

  it("fails on shopName mismatch (strict equality)", () => {
    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: SHOPS["bigmk"]!,
      pageShopName: "BIGMK.PH",
      pageShopCode: "PHLCSLWL2G",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("shop_mismatch");
      expect(result.error).toContain("shop_mismatch");
    }
  });

  it("fails on shopCode mismatch", () => {
    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: SHOPS["bigmk"]!,
      pageShopName: "bigmk.ph",
      pageShopCode: "WRONG_CODE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("shop_mismatch");
    }
  });

  it("fails when both shopName and shopCode mismatch", () => {
    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: SHOPS["bigmk"]!,
      pageShopName: "other.ph",
      pageShopCode: "OTHER_CODE",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("shop_mismatch");
      expect(result.error).toContain("other.ph");
      expect(result.error).toContain("OTHER_CODE");
    }
  });

  it("does not allow partial/fuzzy matching", () => {
    const result = validateShopIdentity({
      shopKey: "bigmk",
      config: SHOPS["bigmk"]!,
      pageShopName: "bigmk.ph ",
      pageShopCode: "PHLCSLWL2G",
    });
    // trailing space → mismatch (strict ===)
    expect(result.ok).toBe(false);
  });

  it("validates second shop independently", () => {
    const result = validateShopIdentity({
      shopKey: "sumifun",
      config: SHOPS["sumifun"]!,
      pageShopName: "sumifun.ph",
      pageShopCode: "PHSUMIFUN1",
    });
    expect(result.ok).toBe(true);
  });
});
