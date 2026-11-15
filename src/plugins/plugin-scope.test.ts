// Verifies plugin scope parsing and boundary checks.
import { describe, expect, it } from "vitest";
import { normalizePluginIdScope } from "./plugin-scope.js";

describe("normalizePluginIdScope", () => {
  it("normalizes scope entries while ignoring non-string values", () => {
    expect(
      normalizePluginIdScope([" beta ", "alpha", "beta", "", null, 42, { id: "beta" }]),
    ).toEqual(["alpha", "beta"]);
  });
});
