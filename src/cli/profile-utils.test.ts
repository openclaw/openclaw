import { describe, expect, it } from "vitest";
import { isValidProfileName, normalizeProfileName } from "./profile-utils.js";

describe("profile-utils", () => {
  it("accepts path-safe profile names and rejects unsafe values", () => {
    expect(isValidProfileName("ironclaw")).toBe(true);
    expect(isValidProfileName("Team_A-1")).toBe(true);
    expect(isValidProfileName("")).toBe(false);
    expect(isValidProfileName(" has-space ")).toBe(false);
    expect(isValidProfileName("../escape")).toBe(false);
    expect(isValidProfileName("slash/name")).toBe(false);
  });

  it("normalizes profile input and collapses default/invalid profiles to null", () => {
    expect(normalizeProfileName("  dev  ")).toBe("dev");
    expect(normalizeProfileName("DEFAULT")).toBeNull();
    expect(normalizeProfileName("")).toBeNull();
    expect(normalizeProfileName("bad profile")).toBeNull();
    expect(normalizeProfileName(undefined)).toBeNull();
  });
});
