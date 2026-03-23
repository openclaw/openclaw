import { describe, expect, it } from "vitest";
import { resolveAccountEntry } from "./account-lookup.js";

describe("resolveAccountEntry", () => {
  it("resolves direct and case-insensitive account keys", () => {
    const accounts = {
      default: { id: "default" },
      Business: { id: "business" },
    };
    expect(resolveAccountEntry(accounts, "default")).toEqual({ id: "default" });
    expect(resolveAccountEntry(accounts, "business")).toEqual({ id: "business" });
  });

  it("ignores prototype-chain values", () => {
    const inherited = { default: { id: "polluted" } };
    const accounts = Object.create(inherited) as Record<string, { id: string }>;
    expect(resolveAccountEntry(accounts, "default")).toBeUndefined();
  });
});
