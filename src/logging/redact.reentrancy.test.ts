import { describe, expect, it, vi } from "vitest";
import { redactSensitiveText } from "../plugin-sdk/security-runtime.js";
import { compileSafeRegexDetailed } from "../security/safe-regex.js";
import {
  computeSensitiveRedactionBitmap,
  getDefaultRedactPatterns,
  redactInputTextWithSourcePolicy,
  redactSensitiveFieldValue,
  resolveRedactOptions,
} from "./redact.js";

function sharedPatternMatching(input: string): RegExp {
  const pattern = resolveRedactOptions({ mode: "tools" }).patterns.find(
    (candidate): candidate is RegExp =>
      candidate instanceof RegExp && new RegExp(candidate.source, candidate.flags).test(input),
  );
  if (!pattern) {
    throw new Error(`No built-in regex matches synthetic fixture ${input}`);
  }
  const compiled = compileSafeRegexDetailed(pattern.source, pattern.flags);
  if (!compiled.regex) {
    throw new Error("The built-in fixture regex must compile");
  }
  return compiled.regex;
}

describe("nested redaction calls", () => {
  it("preserves shared regex state across nested bitmap scans", () => {
    const pattern = /fixture/g;
    const exec = pattern.exec.bind(pattern);
    let nested = false;
    const resolved = { mode: "tools" as const, patterns: [pattern] };
    const spy = vi.spyOn(pattern, "exec").mockImplementation((input) => {
      const match = exec(input);
      if (match && !nested) {
        nested = true;
        try {
          expect(computeSensitiveRedactionBitmap("fixture!", resolved).map(Number).join("")).toBe(
            "11111110",
          );
        } finally {
          nested = false;
        }
      }
      return match;
    });
    pattern.lastIndex = 3;
    try {
      expect(
        computeSensitiveRedactionBitmap("fixture fixture", resolved).map(Number).join(""),
      ).toBe("111111101111111");
      expect(pattern.lastIndex).toBe(3);
    } finally {
      spy.mockRestore();
    }
  });

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

  it.each(["API_TOKEN=", "pass: "])("keeps nested source assignment policy for %s", (prefix) => {
    const input = `${prefix}computeFirst()\n${prefix}computeSecond()`;
    const assignments: string[] = [];

    expect(
      redactInputTextWithSourcePolicy(input, undefined, (text, offset) => {
        expect(redactSensitiveText("pass: private pass: nested", { mode: "tools" })).toBe(
          "pass: *** pass: ***",
        );
        assignments.push(text.slice(offset).split("\n")[0] ?? "");
        return true;
      }),
    ).toBe(input);
    expect(assignments).toEqual(expect.arrayContaining(["computeFirst()", "computeSecond()"]));
  });

  it("rechecks vendor candidates after an intervening custom replacement", () => {
    const injector = {
      source: "synthetic vendor injection",
      *exec(input: string) {
        for (const match of input.matchAll(/\{inject\}/g)) {
          yield {
            match: match[0],
            groups: [],
            input,
            offset: match.index,
            replacement: "gho_abcdefghij",
          };
        }
      },
    };
    expect(
      redactSensitiveText("{inject}", {
        patterns: [
          String.raw`(ghp_[A-Za-z0-9]{10,})`,
          injector,
          String.raw`(gho_[A-Za-z0-9]{10,})`,
        ],
      }),
    ).toBe("***");
  });
});

describe("shared compiled redaction patterns", () => {
  it.each(["API_TOKEN=tiny-value", "ghp_abcdefghij"])(
    "admits a changed shared rule through only a legacy key word for %s",
    (fixture) => {
      const pattern = sharedPatternMatching(fixture);
      const { source, flags } = pattern;
      try {
        pattern.compile("(fixtureTOKEN)", "g");
        resolveRedactOptions({ patterns: getDefaultRedactPatterns() });
        expect(redactSensitiveText("fixtureTOKEN", { mode: "tools" })).toBe("***");
        expect(redactSensitiveFieldValue("content", "fixtureTOKEN", { mode: "tools" })).toBe("***");
      } finally {
        pattern.compile(source, flags);
      }
    },
  );

  it.each(["API_TOKEN=tiny-value", "ghp_abcdefghij"])(
    "resets a skipped global rule before the next custom rule for %s",
    (fixture) => {
      const pattern = sharedPatternMatching(fixture);
      const observer = {
        source: "synthetic global regex state observer",
        *exec(input: string) {
          yield {
            match: input,
            groups: [],
            input,
            offset: 0,
            replacement: String(pattern.lastIndex),
          };
        },
      };
      pattern.lastIndex = 7;
      try {
        expect(redactSensitiveText("fixture-unlisted", { patterns: [pattern, observer] })).toBe(
          "0",
        );
      } finally {
        pattern.lastIndex = 0;
      }
    },
  );

  it.each(["API_TOKEN=tiny-value", "ghp_abcdefghij"])(
    "uses a custom executor on a rule originally matching %s",
    (fixture) => {
      const pattern = sharedPatternMatching(fixture);
      const replacement = /fixture-unlisted/g;
      const executor = vi
        .spyOn(pattern, "exec")
        .mockImplementation((input) => replacement.exec(input));
      try {
        resolveRedactOptions({ patterns: getDefaultRedactPatterns() });
        expect(redactSensitiveText("fixture-unlisted", { patterns: [pattern] })).toBe("***");
      } finally {
        executor.mockRestore();
      }
    },
  );

  it("uses changed case flags on a shared assignment rule", () => {
    const pattern = sharedPatternMatching("API_TOKEN=tiny-value");
    const { source, flags } = pattern;
    try {
      pattern.compile(source, "gi");
      expect(redactSensitiveText("password: tiny-value", { patterns: [pattern] })).toBe(
        "password: ***",
      );
    } finally {
      pattern.compile(source, flags);
    }
  });

  it.each(["API_TOKEN=tiny-value", "ghp_abcdefghij"])(
    "uses a custom replacement hook on a rule originally matching %s",
    (fixture) => {
      const pattern = sharedPatternMatching(fixture);
      const replacement = /fixture-unlisted/g;
      const hook = vi
        .spyOn(pattern, Symbol.replace)
        .mockImplementation((input, replace) => replacement[Symbol.replace](input, replace));
      try {
        resolveRedactOptions({ patterns: getDefaultRedactPatterns() });
        expect(redactSensitiveText("fixture-unlisted", { patterns: [pattern] })).toBe("***");
      } finally {
        hook.mockRestore();
      }
    },
  );
});
