import { describe, expect, it } from "vitest";
import { collectPreparedPrepackErrors, shouldSkipPrepack } from "../scripts/openclaw-prepack.ts";

describe("shouldSkipPrepack", () => {
  it("treats unset and explicit false values as disabled", () => {
    expect(shouldSkipPrepack({})).toBe(false);
    expect(shouldSkipPrepack({ OPENCLAW_PREPACK_PREPARED: "0" })).toBe(false);
    expect(shouldSkipPrepack({ OPENCLAW_PREPACK_PREPARED: "false" })).toBe(false);
  });

  it("treats non-false values as enabled", () => {
    expect(shouldSkipPrepack({ OPENCLAW_PREPACK_PREPARED: "1" })).toBe(true);
    expect(shouldSkipPrepack({ OPENCLAW_PREPACK_PREPARED: "true" })).toBe(true);
  });
});

describe("collectPreparedPrepackErrors", () => {
  it("accepts prepared release artifacts", () => {
    expect(
      collectPreparedPrepackErrors(
        ["dist/index.mjs", "dist/control-ui/index.html"],
        ["dist/control-ui/assets/index-Bu8rSoJV.js"],
      ),
    ).toEqual([]);
  });

  it("reports missing build and control ui artifacts", () => {
    expect(collectPreparedPrepackErrors([], [])).toEqual([
      "missing required prepared artifact: dist/index.js or dist/index.mjs",
      "missing required prepared artifact: dist/control-ui/index.html",
      "missing prepared Control UI asset payload under dist/control-ui/assets/",
    ]);
  });
});
