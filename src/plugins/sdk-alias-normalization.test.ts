import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { buildPluginLoaderJitiOptions, createPluginLoaderModuleCacheKey } from "./sdk-alias.js";

describe("buildPluginLoaderJitiOptions alias normalization", () => {
  it("keeps plugin loader module cache keys stable across alias insertion order", () => {
    expect(
      createPluginLoaderModuleCacheKey({
        tryNative: true,
        aliasMap: {
          zeta: "/repo/zeta.js",
          alpha: "/repo/alpha.js",
        },
      }),
    ).toBe(
      createPluginLoaderModuleCacheKey({
        tryNative: true,
        aliasMap: {
          alpha: "/repo/alpha.js",
          zeta: "/repo/zeta.js",
        },
      }),
    );
  });

  it("pre-normalizes and marks alias maps for source transforms", () => {
    const marker = Symbol.for("pathe:normalizedAlias");
    const aliasMap = {
      "openclaw/plugin-sdk/core": "/repo/src/plugin-sdk/core.ts",
      "@openclaw/plugin-sdk/core": "/repo/src/plugin-sdk/core.ts",
    };

    const first = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;
    const second = buildPluginLoaderJitiOptions({ ...aliasMap }).alias as Record<string, string>;

    expect(second).toBe(first);
    expect((first as Record<symbol, unknown>)[marker]).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(first, marker)).toBe(false);
  });

  it("applies source-transform alias-target normalization before caching", () => {
    const aliasMap = {
      alpha: "/repo/alpha",
      beta: "alpha/sub",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias).not.toBe(aliasMap);
    expect(alias.beta).toBe("/repo/alpha/sub");
  });

  it("follows chained source-transform alias targets", () => {
    const aliasMap = {
      alpha: "/repo/alpha",
      gamma: "beta/gamma",
      beta: "alpha/beta",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.gamma).toBe("/repo/alpha/beta/gamma");
  });

  it("does not rewrite concrete Windows drive alias targets", () => {
    const aliasMap = {
      "C:": "/wrong",
      beta: "C:/repo/beta",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.beta).toBe("C:/repo/beta");
  });

  it("stops chained source-transform alias rewrites after reaching a Windows drive target", () => {
    const aliasMap = {
      beta: "C:/repo/beta",
      "C:": "/wrong",
      alpha: "beta/alpha",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(alias.alpha).toBe("C:/repo/beta/alpha");
  });

  it("bounds cyclic source-transform alias targets", () => {
    const aliasMap = {
      alpha: "beta/a",
      beta: "alpha/b",
      gamma: "alpha/g",
    };

    const alias = buildPluginLoaderJitiOptions(aliasMap).alias as Record<string, string>;

    expect(expectDefined(alias.gamma, "alias.gamma test invariant").length).toBeLessThan(32);
  });

  it("does not attach an empty alias map", () => {
    expect(buildPluginLoaderJitiOptions({})).not.toHaveProperty("alias");
  });
});
