import { describe, expect, it } from "vitest";
import { resolveEngineConfigurations } from "../../scripts/lib/control-ui-engine-configurations.ts";

describe("engine configuration selection", () => {
  it("keeps the default and separately named A/A control identical", () => {
    const [baseline, control] = resolveEngineConfigurations("default, control");
    expect(baseline).toEqual({
      name: "default",
      theme: "claw",
      themeMode: "light",
      locale: "en",
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "no-preference",
      forcedColors: "none",
    });
    expect(control).toEqual({ ...baseline, name: "control" });
  });

  it("resolves each axis without changing unrelated defaults", () => {
    const [baseline] = resolveEngineConfigurations("default");
    const variants = resolveEngineConfigurations(
      "theme:crt:dark,theme:knot:light,locale:ja-JP,scale:3,reduced-motion,forced-colors",
    );
    expect(variants).toEqual([
      { ...baseline, name: "theme:crt:dark", theme: "crt", themeMode: "dark", colorScheme: "dark" },
      { ...baseline, name: "theme:knot:light", theme: "knot" },
      { ...baseline, name: "locale:ja-JP", locale: "ja-JP" },
      { ...baseline, name: "scale:3", deviceScaleFactor: 3 },
      { ...baseline, name: "reduced-motion", reducedMotion: "reduce" },
      { ...baseline, name: "forced-colors", forcedColors: "active" },
    ]);
  });

  it("expands the complete census without duplicating Claw light or the A/A control", () => {
    const configurations = resolveEngineConfigurations("all");
    const names = configurations.map(({ name }) => name);
    expect(configurations).toHaveLength(29);
    expect(new Set(names).size).toBe(configurations.length);
    expect(names).toContain("theme:crt:light");
    expect(names).toContain("theme:crt:dark");
    expect(names).toContain("theme:phosphor:light");
    expect(names).toContain("theme:phosphor:dark");
    expect(names).toContain("locale:zh-CN");
    expect(names).toContain("locale:ar");
    expect(names).toContain("locale:de");
    expect(names).toContain("scale:2");
    expect(names).not.toContain("theme:claw:light");
    expect(names).not.toContain("control");
  });

  it.each(["default,default", "all,default", "all,theme:crt:dark"])(
    "rejects repeated observation names in %s",
    (selection) => {
      expect(() => resolveEngineConfigurations(selection)).toThrow("distinct");
    },
  );

  it.each([
    "",
    "default,",
    "unknown",
    "theme:custom:dark",
    "theme:crt:system",
    "theme:crt:dark:extra",
    "theme:crt:dark:",
    "locale:en-US",
    "locale:ar:dark",
    "scale:1",
    "scale:4",
    "scale:2:dark",
  ])("rejects invalid configuration %j", (selection) => {
    expect(() => resolveEngineConfigurations(selection)).toThrow("Unsupported");
  });
});
