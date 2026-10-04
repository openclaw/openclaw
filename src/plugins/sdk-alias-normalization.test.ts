import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { buildPluginLoaderJitiOptions, createPluginLoaderModuleCacheKey } from "./sdk-alias.js";

describe("buildPluginLoaderJitiOptions alias normalization", () => {
  it("keeps plugin loader module cache keys stable across alias insertion order", () => {
    const aliasMap = { zeta: "/repo/zeta.js", alpha: "/repo/alpha.js" };
    expect(createPluginLoaderModuleCacheKey({ tryNative: true, aliasMap })).toBe(
      createPluginLoaderModuleCacheKey({
        tryNative: true,
        aliasMap: Object.fromEntries(Object.entries(aliasMap).toReversed()),
      }),
    );
  });

  it.each<{ aliasMap: Record<string, string>; expected: Record<string, string> }>([
    {
      aliasMap: { alpha: "/repo/alpha", beta: "alpha/sub" },
      expected: { beta: "/repo/alpha/sub" },
    },
    {
      aliasMap: { alpha: "/repo/alpha", gamma: "beta/gamma", beta: "alpha/beta" },
      expected: { gamma: "/repo/alpha/beta/gamma" },
    },
    {
      aliasMap: { beta: "C:/repo/beta", "C:": "/wrong", alpha: "beta/alpha" },
      expected: { beta: "C:/repo/beta", alpha: "C:/repo/beta/alpha" },
    },
  ])("normalizes and caches source-transform targets: $expected", ({ aliasMap, expected }) => {
    const marker = Symbol.for("pathe:normalizedAlias");
    const alias = expectDefined(buildPluginLoaderJitiOptions(aliasMap).alias, "normalized alias");
    expect(alias).not.toBe(aliasMap);
    expect(alias).toMatchObject(expected);
    expect(buildPluginLoaderJitiOptions({ ...aliasMap }).alias).toBe(alias);
    expect(Reflect.get(alias, marker)).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(alias, marker)).toBe(false);
  });

  it("bounds cyclic source-transform alias targets", () => {
    const alias = buildPluginLoaderJitiOptions({
      alpha: "beta/a",
      beta: "alpha/b",
      gamma: "alpha/g",
    }).alias;
    expect(expectDefined(alias?.gamma, "alias.gamma test invariant").length).toBeLessThan(32);
  });

  it("does not attach an empty alias map", () => {
    expect(buildPluginLoaderJitiOptions({})).not.toHaveProperty("alias");
  });
});
