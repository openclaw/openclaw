import { expect, it } from "vitest";
import {
  formatAllowFromLowercase,
  formatNormalizedAllowFromEntries,
  isNormalizedSenderAllowed,
  mapAllowlistResolutionInputs,
  parseAllowFromEntries,
  resolveBasicAllowFromEntries,
} from "./allow-from.js";

it.each([
  ["*", undefined, true],
  ["zl:12345", /^(zalo|zl):/i, false],
] as const)("checks sender against %s", (entry, stripPrefixRe, expected) => {
  expect(isNormalizedSenderAllowed({ senderId: "999", allowFrom: [entry], stripPrefixRe })).toBe(
    expected,
  );
});

it("trims, strips prefixes, and lowercases entries", () => {
  expect(
    formatAllowFromLowercase({
      allowFrom: [" Telegram:UserA ", "tg:UserB", "  "],
      stripPrefixRe: /^(telegram|tg):/i,
    }),
  ).toEqual(["usera", "userb"]);
});

it("filters empty normalized entries", () => {
  const normalizeEntry = (entry: string) => entry.replace(/^@$/, "");
  const entries = formatNormalizedAllowFromEntries({ allowFrom: ["@", "valid"], normalizeEntry });
  expect(entries).toEqual(["valid"]);
});

it("preserves wildcard entries and returns the first parser error", () => {
  const parse = (raw: string) =>
    parseAllowFromEntries(raw, (entry) =>
      entry === "bad" ? { error: "invalid" } : { value: entry.toLowerCase() },
    );

  expect(parse(" Alice, *, alice ")).toEqual({ entries: ["alice", "*"] });
  expect(parse("ok; bad; later")).toEqual({ entries: [], error: "invalid" });
});

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
