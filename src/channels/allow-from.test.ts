import { describe, expect, it } from "vitest";
import { firstDefined, isSenderIdAllowed, mergeAllowFromSources } from "./allow-from.js";

describe("mergeAllowFromSources", () => {
  it("merges, trims, and filters empty values", () => {
    expect(
      mergeAllowFromSources({
        allowFrom: ["  line:user:abc  ", "", 123],
        storeAllowFrom: ["   ", "telegram:456"],
      }),
    ).toEqual(["line:user:abc", "123", "telegram:456"]);
  });

  it("excludes pairing-store entries when dmPolicy is allowlist", () => {
    expect(
      mergeAllowFromSources({
        allowFrom: ["+1111"],
        storeAllowFrom: ["+2222", "+3333"],
        dmPolicy: "allowlist",
      }),
    ).toEqual(["+1111"]);
  });

  it("keeps pairing-store entries for non-allowlist policies", () => {
    expect(
      mergeAllowFromSources({
        allowFrom: ["+1111"],
        storeAllowFrom: ["+2222"],
        dmPolicy: "pairing",
      }),
    ).toEqual(["+1111", "+2222"]);
  });
});

describe("firstDefined", () => {
  it("returns the first non-undefined value", () => {
    expect(firstDefined(undefined, undefined, "x", "y")).toBe("x");
    expect(firstDefined(undefined, 0, 1)).toBe(0);
  });
});

describe("isSenderIdAllowed", () => {
  it("supports per-channel empty-list defaults and wildcard/id matches", () => {
    expect(
      isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "123",
        true,
      ),
    ).toBe(true);
    expect(
      isSenderIdAllowed(
        {
          entries: [],
          hasEntries: false,
          hasWildcard: false,
        },
        "123",
        false,
      ),
    ).toBe(false);
    expect(
      isSenderIdAllowed(
        {
          entries: ["111", "222"],
          hasEntries: true,
          hasWildcard: true,
        },
        undefined,
        false,
      ),
    ).toBe(true);
    expect(
      isSenderIdAllowed(
        {
          entries: ["111", "222"],
          hasEntries: true,
          hasWildcard: false,
        },
        "222",
        false,
      ),
    ).toBe(true);
  });
});
