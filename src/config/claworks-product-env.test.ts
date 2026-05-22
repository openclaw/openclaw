import { describe, expect, it } from "vitest";
import { looksLikeClaworksStateEnv } from "./claworks-product-env.js";

describe("claworks-product-env", () => {
  it("detects ClaWorks state paths", () => {
    expect(looksLikeClaworksStateEnv({ OPENCLAW_STATE_DIR: "/home/u/.claworks" })).toBe(true);
    expect(
      looksLikeClaworksStateEnv({ OPENCLAW_CONFIG_PATH: "/home/u/.claworks/claworks.json" }),
    ).toBe(true);
    expect(looksLikeClaworksStateEnv({ OPENCLAW_STATE_DIR: "/home/u/.openclaw" })).toBe(false);
  });
});
