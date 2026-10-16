/**
 * Tests allow-from parsing and normalization helpers.
 */
import { describe, expect, it } from "vitest";
import {
  formatAllowFromLowercase,
  formatNormalizedAllowFromEntries,
  isNormalizedSenderAllowed,
  mapAllowlistResolutionInputs,
  parseAllowFromEntries,
  resolveBasicAllowFromEntries,
} from "./allow-from.js";

describe("isNormalizedSenderAllowed", () => {
  it.each([
    {
      name: "allows wildcard",
      input: {
        senderId: "attacker",
        allowFrom: ["*"],
      },
      expected: true,
    },
    {
      name: "rejects when sender is missing",
      input: {
        senderId: "999",
        allowFrom: ["zl:12345"],
        stripPrefixRe: /^(zalo|zl):/i,
      },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(isNormalizedSenderAllowed(input)).toBe(expected);
  });
});

describe("formatAllowFromLowercase", () => {
  it("trims, strips prefixes, and lowercases entries", () => {
    expect(
      formatAllowFromLowercase({
        allowFrom: [" Telegram:UserA ", "tg:UserB", "  "],
        stripPrefixRe: /^(telegram|tg):/i,
      }),
    ).toEqual(["usera", "userb"]);
  });
});

describe("formatNormalizedAllowFromEntries", () => {
  it.each([
    {
      name: "filters empty normalized entries",
      input: {
        allowFrom: ["@", "valid"],
        normalizeEntry: (entry: string) => entry.replace(/^@$/, ""),
      },
      expected: ["valid"],
    },
  ])("$name", ({ input, expected }) => {
    expect(formatNormalizedAllowFromEntries(input)).toEqual(expected);
  });
});

describe("parseAllowFromEntries", () => {
  it("preserves wildcard entries and returns the first parser error", () => {
    const parse = (raw: string) =>
      parseAllowFromEntries(raw, (entry) =>
        entry === "bad" ? { error: "invalid" } : { value: entry.toLowerCase() },
      );

    expect(parse(" Alice, *, alice ")).toEqual({ entries: ["alice", "*"] });
    expect(parse("ok; bad; later")).toEqual({ entries: [], error: "invalid" });
  });
});

describe("resolveBasicAllowFromEntries", () => {
  it("uses unresolved records without a token and canonicalizes resolved ids", async () => {
    const resolveEntries = async ({ entries }: { token: string; entries: string[] }) =>
      entries.map((input) => ({
        input,
        resolved: true,
        id: input === "missing" ? undefined : "1",
      }));

    await expect(
      resolveBasicAllowFromEntries({ entries: ["alice"], resolveEntries }),
    ).resolves.toEqual([{ input: "alice", resolved: false, id: null }]);
    await expect(
      resolveBasicAllowFromEntries({
        token: " token ",
        entries: ["alice", "missing"],
        resolveEntries,
      }),
    ).resolves.toEqual([
      { input: "alice", resolved: true, id: "1" },
      { input: "missing", resolved: true, id: null },
    ]);
  });
});

describe("mapAllowlistResolutionInputs", () => {
  it("maps inputs sequentially and preserves order", async () => {
    const firstStarted = Promise.withResolvers<void>();
    const firstResolution = Promise.withResolvers<void>();
    const visited: string[] = [];
    const result = mapAllowlistResolutionInputs({
      inputs: ["one", "two", "three"],
      mapInput: async (input) => {
        visited.push(input);
        if (input === "one") {
          firstStarted.resolve();
          await firstResolution.promise;
        }
        return input.toUpperCase();
      },
    });

    try {
      await Promise.race([firstStarted.promise, result]);
      expect(visited).toEqual(["one"]);
    } finally {
      firstResolution.resolve();
      await result;
    }

    expect(visited).toEqual(["one", "two", "three"]);
    expect(await result).toEqual(["ONE", "TWO", "THREE"]);
  });
});
