import { expect, it } from "vitest";
import {
  booleanFlag,
  classifyBoundedUnsignedDecimal,
  intFlag,
  isOpenEndedTruthyValue,
  isStrictAffirmativeValue,
  parseFlagArgs,
  parsePermissiveBooleanToken,
  readFlagValue,
  requireOptionArgument,
  stringFlag,
  stringListFlag,
} from "../../scripts/lib/arg-utils.runtime.mjs";

const parseString = (argv: string[], options: Parameters<typeof stringFlag>[2] = {}) =>
  parseFlagArgs(argv, { value: "" }, [stringFlag("--value", "value", options)]);
const parseMatches = (argv: string[], options: Parameters<typeof stringListFlag>[2] = {}) =>
  parseFlagArgs(argv, { match: [] as string[] }, [stringListFlag("--match", "match", options)]);
const parse = (args: string) =>
  parseFlagArgs(args.split(" "), { value: "", limit: 1, json: false }, [
    stringFlag("--value", "value"),
    intFlag("--limit", "limit", { min: 1 }),
    booleanFlag("--json", "json"),
  ]);

it.each([
  ["yes", true],
  ["off", false],
  ["enabled", undefined],
  [true, undefined],
] as const)("parses permissive Boolean token %j", (input, expected) =>
  expect(parsePermissiveBooleanToken(input)).toBe(expected),
);

it.each([
  ["0", 1, "below"],
  ["-1", 0, "syntax"],
] as const)("classifies bounded unsigned decimal %s", (input, min, kind) =>
  expect(classifyBoundedUnsignedDecimal(input, min, 10)).toEqual({ kind }),
);
it("returns the original split option value", () =>
  expect(requireOptionArgument(["--output", "  report.json  "], 0, "--output")).toBe(
    "  report.json  ",
  ));
it("rejects an empty split option value", () =>
  expect(() => requireOptionArgument(["--output", ""], 0, "--output")).toThrow(
    "--output requires a value",
  ));

it("defaults absent open-ended truthiness to false", () =>
  expect(isOpenEndedTruthyValue(undefined)).toBe(false));
it("normalizes affirmative token casing", () => expect(isStrictAffirmativeValue("Yes")).toBe(true));

it.each([
  [["-p", "first", "-p", "second"], "-p"],
  [["--file", "first", "--file=second"], "--file"],
] as const)("uses the last value for %j", (argv, flag) =>
  expect(readFlagValue(argv, flag)).toBe("second"),
);

it("ignores the conventional option separator by default", () =>
  expect(parse("-- --limit 30 --json")).toEqual({ value: "", limit: 30, json: true }));

it("collects repeatable string flags", () =>
  expect(parseMatches(["--match", "alpha", "--match=beta"]).match).toEqual(["alpha", "beta"]));

it("supports split-only, empty, transformed, and last-value-wins string contracts", () => {
  expect(() => parseString(["--value=inline"], { allowInline: false })).toThrow(
    "Unknown option: --value=inline",
  );
  expect(
    parseString(["--value", "", "--value", "SECOND"], {
      allowEmpty: true,
      repeatable: true,
      transform: (value) => value.toLowerCase(),
    }).value,
  ).toBe("second");
});

it.each([
  ["--limit", "--limit requires a value"],
  ["--limit --value x", "--limit requires a value"],
  ["--limit 20files", "--limit must be an integer"],
  ["--limit 0", "--limit must be at least 1"],
])("rejects %s", (args, message) => expect(() => parse(args)).toThrow(message));

it("rejects inline short options as string-list values", () => {
  expect(() => parseMatches(["--match=-h"], { rejectShortOptions: true })).toThrow(
    "--match requires a value",
  );
});

it("can preserve the option separator for callers that need to handle it", () => {
  const seen: string[] = [];

  parseFlagArgs(["--"], {}, [], {
    ignoreDoubleDash: false,
    onUnhandledArg(arg) {
      seen.push(arg);
      return "handled";
    },
  });

  expect(seen).toEqual(["--"]);
});
