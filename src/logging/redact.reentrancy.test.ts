import { assert, describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../plugin-sdk/security-runtime.js";
import { compileSafeRegexDetailed } from "../security/safe-regex.js";
import {
  getDefaultRedactPatterns,
  redactSensitiveFieldValue,
  resolveRedactOptions,
} from "./redact.js";

function sharedPatternMatching(input: string): RegExp {
  const pattern = resolveRedactOptions({ mode: "tools" }).patterns.find(
    (candidate): candidate is RegExp =>
      candidate instanceof RegExp && new RegExp(candidate.source, candidate.flags).test(input),
  );
  assert(pattern, `No built-in regex matches synthetic fixture ${input}`);
  const compiled = compileSafeRegexDetailed(pattern.source, pattern.flags);
  assert(compiled.regex, "The built-in fixture regex must compile");
  return compiled.regex;
}

function withSharedPattern(fixture: string, run: (pattern: RegExp) => void) {
  const pattern = sharedPatternMatching(fixture);
  const { source, flags, lastIndex } = pattern;
  try {
    run(pattern);
  } finally {
    vi.restoreAllMocks();
    pattern.compile(source, flags);
    pattern.lastIndex = lastIndex;
  }
}

function replacementMatcher(pattern: RegExp, replacement: () => string) {
  return {
    source: pattern.source,
    *exec(input: string) {
      for (const match of input.matchAll(pattern)) {
        const result = { match: match[0], groups: [], input, offset: match.index };
        yield { ...result, replacement: replacement() };
      }
    },
  };
}

describe("nested redaction calls", () => {
  it("keeps nested matcher input and pattern order", () => {
    const inputs: string[] = [];
    const nested: string[] = [];
    const matcher = {
      source: "bracketed fixture values",
      *exec(input: string) {
        inputs.push(input);
        for (const match of input.matchAll(/\[(outer-[a-z]+)\]/g)) {
          nested.push(redactSensitiveText("inside private", { patterns: [/private/g] }));
          yield { match: match[0], groups: [match[1] ?? ""], input, offset: match.index };
        }
      },
    };

    const input = "prefix [outer-one] [outer-two] suffix";
    const patterns = [/prefix/g, matcher, /suffix/g];
    expect(redactSensitiveText(input, { patterns })).toBe("*** [***] [***] ***");
    expect(inputs).toEqual(["*** [outer-one] [outer-two] suffix"]);
    expect(nested).toEqual(["inside ***", "inside ***"]);
  });

  it("rechecks vendor candidates after an intervening custom replacement", () => {
    const injector = replacementMatcher(/\{inject\}/g, () => "gho_abcdefghij");
    const patterns = [
      String.raw`(ghp_[A-Za-z0-9]{10,})`,
      injector,
      String.raw`(gho_[A-Za-z0-9]{10,})`,
    ];
    expect(redactSensitiveText("{inject}", { patterns })).toBe("***");
  });
  const cases = ["source", "executor", "replacement hook"].flatMap((kind) =>
    ["API_TOKEN=tiny-value", "ghp_abcdefghij"].map((fixture) => ({ kind, fixture })),
  );
  it.each(cases)("honors changed $kind on $fixture", ({ fixture, kind }) => {
    withSharedPattern(fixture, (pattern) => {
      const replacement = /fixture-unlisted/g;
      if (kind === "source") {
        pattern.compile("(fixtureTOKEN)", "g");
      } else if (kind === "executor") {
        vi.spyOn(pattern, "exec").mockImplementation((input) => replacement.exec(input));
      } else {
        vi.spyOn(pattern, Symbol.replace).mockImplementation((input, replace) =>
          replacement[Symbol.replace](input, replace),
        );
      }
      resolveRedactOptions({ patterns: getDefaultRedactPatterns() });
      if (kind === "source") {
        expect(redactSensitiveText("fixtureTOKEN", { mode: "tools" })).toBe("***");
        expect(redactSensitiveFieldValue("content", "fixtureTOKEN", { mode: "tools" })).toBe("***");
      } else {
        expect(redactSensitiveText("fixture-unlisted", { patterns: [pattern] })).toBe("***");
      }
    });
  });

  it.each(["API_TOKEN=tiny-value", "ghp_abcdefghij"])(
    "resets skipped global state for %s",
    (fixture) =>
      withSharedPattern(fixture, (pattern) => {
        const observer = replacementMatcher(/^.*$/g, () => String(pattern.lastIndex));
        pattern.lastIndex = 7;
        expect(redactSensitiveText("fixture-unlisted", { patterns: [pattern, observer] })).toBe(
          "0",
        );
      }),
  );

  it("uses changed case flags on a shared assignment rule", () => {
    withSharedPattern("API_TOKEN=tiny-value", (pattern) => {
      pattern.compile(pattern.source, "gi");
      expect(redactSensitiveText("password: tiny-value", { patterns: [pattern] })).toBe(
        "password: ***",
      );
    });
  });
});
