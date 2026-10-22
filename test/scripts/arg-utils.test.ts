import { expect, it } from "vitest";
import {
  booleanFlag,
  classifyBoundedUnsignedDecimal,
  intFlag,
  isOpenEndedTruthyValue,
  isStrictAffirmativeValue,
  parseFlagArgs,
  parsePermissiveBooleanToken,
  parseStrictBooleanArg,
  readFlagValue,
  requireOptionArgument,
  stringFlag,
  stringListFlag,
} from "../../scripts/lib/arg-utils.runtime.mjs";

const parseLimit = (argv: string[]) =>
  parseFlagArgs(argv, { limit: 10 }, [intFlag("--limit", "limit", { min: 1 })]);
const parseString = (argv: string[], options: Parameters<typeof stringFlag>[2] = {}) =>
  parseFlagArgs(argv, { value: "" }, [stringFlag("--value", "value", options)]);
const parseMatches = (argv: string[], options: Parameters<typeof stringListFlag>[2] = {}) =>
  parseFlagArgs(argv, { match: [] as string[] }, [stringListFlag("--match", "match", options)]);

it.each([
  ["strict", "true", true],
  ["strict", "false", false],
  ["strict", true, "--enabled must be true or false."],
  ["permissive", "yes", true],
  ["permissive", "off", false],
  ["permissive", "enabled", undefined],
  ["permissive", true, undefined],
] as const)("parses %s Boolean token %j", (mode, input, expected) => {
  const parse = () =>
    mode === "strict"
      ? parseStrictBooleanArg(input, "--enabled")
      : parsePermissiveBooleanToken(input);
  if (typeof expected === "string") {
    expect(parse).toThrow(expected);
  } else {
    expect(parse()).toBe(expected);
  }
});

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

it.each([undefined, "", "-h", "--next"])("rejects missing value %#", (value) => {
  const argv = value === undefined ? ["--output"] : ["--output", value];
  expect(() => requireOptionArgument(argv, 0, "--output")).toThrow(
    new Error("--output requires a value"),
  );
});
it("defaults absent open-ended truthiness to false", () =>
  expect(isOpenEndedTruthyValue(undefined)).toBe(false));

it.each([
  [undefined, false],
  ["Yes", true],
] as const)("applies strict affirmative truthiness to %s", (input, expected) =>
  expect(isStrictAffirmativeValue(input)).toBe(expected),
);
it.each([
  [["-p", "first", "-p", "second"], "-p"],
  [["--file=first", "--file", "second"], "--file"],
] as const)("uses the last value for %j", (argv, flag) =>
  expect(readFlagValue(argv, flag)).toBe("second"),
);

it("ignores the conventional option separator by default", () =>
  expect(parseLimit(["--", "--limit", "30"]).limit).toBe(30));

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

it("rejects duplicate single-value flags", () => {
  expect(() => parseString(["--value", "first", "--value=second"])).toThrow(
    "--value was provided more than once",
  );
  expect(() => parseLimit(["--limit", "1", "--limit=2"])).toThrow(
    "--limit was provided more than once",
  );
  expect(() =>
    parseFlagArgs(["--json", "--json"], { json: false }, [booleanFlag("--json", "json")]),
  ).toThrow("--json was provided more than once");
});

it("rejects missing string flag values before consuming the next option", () => {
  expect(() =>
    parseFlagArgs(["--base", "--head", "HEAD"], { base: "origin/main", head: "HEAD" }, [
      stringFlag("--base", "base"),
      stringFlag("--head", "head"),
    ]),
  ).toThrow("--base requires a value");
});

it("can reject short options as string values for CLIs that reserve short flags", () => {
  expect(() => parseString(["--value", "-h"], { rejectShortOptions: true })).toThrow(
    "--value requires a value",
  );
  expect(() => parseMatches(["--match=-h"], { rejectShortOptions: true })).toThrow(
    "--match requires a value",
  );
});

it("rejects missing and malformed numeric flag values", () => {
  expect(() => parseLimit(["--limit"])).toThrow("--limit requires a value");
  expect(() => parseLimit(["--limit", "--factor", "1.5"])).toThrow("--limit requires a value");
  expect(() => parseLimit(["--limit", "20files"])).toThrow("--limit must be an integer");
  expect(() => parseLimit(["--limit", "0"])).toThrow("--limit must be at least 1");
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
