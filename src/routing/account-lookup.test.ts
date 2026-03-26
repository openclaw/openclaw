import { describe, expect, it } from "vitest";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "./account-lookup.js";

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

describe("resolveNormalizedAccountEntry", () => {
  it("resolves normalized account keys with a custom normalizer", () => {
    const accounts = {
      "Ops Team": { id: "ops" },
    };

    expect(
      resolveNormalizedAccountEntry(accounts, "ops-team", (accountId) =>
        accountId.trim().toLowerCase().replaceAll(" ", "-"),
      ),
    ).toEqual({ id: "ops" });
  });

  it("ignores prototype-chain values", () => {
    const inherited = { default: { id: "polluted" } };
    const accounts = Object.create(inherited) as Record<string, { id: string }>;

    expect(
      resolveNormalizedAccountEntry(accounts, "default", (accountId) => accountId),
    ).toBeUndefined();
  });
});
