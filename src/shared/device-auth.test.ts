import { describe, expect, it } from "vitest";
import { normalizeDeviceAuthRole, normalizeDeviceAuthScopes } from "./device-auth.js";

describe("normalizeDeviceAuthRole", () => {
  it("trims whitespace", () => {
    expect(normalizeDeviceAuthRole("  admin  ")).toBe("admin");
  });

  it("returns empty for empty string", () => {
    expect(normalizeDeviceAuthRole("")).toBe("");
  });
});

describe("normalizeDeviceAuthScopes", () => {
  it("returns empty array for undefined", () => {
    expect(normalizeDeviceAuthScopes(undefined)).toEqual([]);
  });

  it("returns empty array for non-array", () => {
    expect(normalizeDeviceAuthScopes("not-array" as unknown)).toEqual([]);
  });

  it("trims, deduplicates, and sorts", () => {
    expect(normalizeDeviceAuthScopes(["  read ", "write", "read", ""])).toEqual(["read", "write"]);
  });

  it("filters empty strings", () => {
    expect(normalizeDeviceAuthScopes(["", "  ", "admin"])).toEqual(["admin"]);
  });
});
