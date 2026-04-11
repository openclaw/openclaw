import { describe, expect, it } from "vitest";
import { normalizeInputHostnameAllowlist } from "./input-allowlist.js";

describe("normalizeInputHostnameAllowlist", () => {
  it("treats a missing allowlist as unset", () => {
    expect(normalizeInputHostnameAllowlist(undefined)).toBeUndefined();
  });

  it("preserves an explicit empty allowlist as deny-all", () => {
    expect(normalizeInputHostnameAllowlist([])).toEqual([]);
  });

  it("fails closed when configured entries trim down to nothing", () => {
    expect(normalizeInputHostnameAllowlist(["", "   "])).toEqual([]);
  });

  it("preserves trimmed hostname patterns", () => {
    expect(normalizeInputHostnameAllowlist([" cdn.example.com ", "*.assets.example.com"])).toEqual([
      "cdn.example.com",
      "*.assets.example.com",
    ]);
  });
});
