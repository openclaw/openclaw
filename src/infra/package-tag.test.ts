import { describe, expect, it } from "vitest";
import { normalizePackageTagInput } from "./package-tag.js";

describe("normalizePackageTagInput", () => {
  const packageNames = ["mullusi", "@mullusi/plugin"] as const;

  it.each([
    { input: undefined, expected: null },
    { input: "   ", expected: null },
    { input: "mullusi@beta", expected: "beta" },
    { input: "@mullusi/plugin@2026.2.24", expected: "2026.2.24" },
    { input: "mullusi@   ", expected: null },
    { input: "mullusi", expected: null },
    { input: " @mullusi/plugin ", expected: null },
    { input: " latest ", expected: "latest" },
    { input: "@other/plugin@beta", expected: "@other/plugin@beta" },
    { input: "mullusier@beta", expected: "mullusier@beta" },
  ] satisfies ReadonlyArray<{ input: string | undefined; expected: string | null }>)(
    "normalizes %j",
    ({ input, expected }) => {
      expect(normalizePackageTagInput(input, packageNames)).toBe(expected);
    },
  );
});
