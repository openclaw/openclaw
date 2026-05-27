import { describe, expect, it } from "vitest";
import { resolveUnusableProfileHint } from "./doctor-auth.js";

describe("resolveUnusableProfileHint", () => {
  it("returns billing guidance for disabled billing profiles", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "billing" })).toBe(
      "Top up credits (provider billing) or switch provider.",
    );
  });

  it("returns credential guidance for permanent auth disables", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "auth_permanent" })).toBe(
      "Refresh or replace credentials, then retry.",
    );
  });

  it("falls back to cooldown guidance for non-billing disable reasons", () => {
    expect(resolveUnusableProfileHint({ kind: "disabled", reason: "unknown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });

  it("returns cooldown guidance for cooldown windows", () => {
    expect(resolveUnusableProfileHint({ kind: "cooldown" })).toBe(
      "Wait for cooldown or switch provider.",
    );
  });
});
