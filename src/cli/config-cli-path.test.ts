import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { mergeAtPath, parseConfigSetValue } from "./config-cli-path.js";

function nestedRecord(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

describe("parseConfigSetValue", () => {
  it.each([
    { raw: "42", expected: 42 },
    { raw: "true", expected: true },
    { raw: "null", expected: null },
    { raw: "{a:1}", expected: { a: 1 } },
    { raw: "[1,2]", expected: [1, 2] },
  ])("parses $raw as expected", ({ raw, expected }) => {
    expect(parseConfigSetValue(raw, false)).toEqual(expected);
  });

  it("falls back to the raw string when JSON5 parsing fails", () => {
    expect(parseConfigSetValue("hello", false)).toBe("hello");
  });

  it.each([
    { raw: "Infinity", label: "Infinity" },
    { raw: "NaN", label: "NaN" },
    { raw: "1e999", label: "overflow exponent" },
    { raw: "{timeout:1e999}", label: "object with overflow exponent" },
    { raw: "[1e999]", label: "array with overflow exponent" },
  ])("rejects $label in value mode", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, false)).toThrow("Value must be a finite number");
  });

  it.each([
    { raw: "1471383327500481391", strictJson: false, literal: "1471383327500481391" },
    { raw: "[1471383327500481391]", strictJson: false, literal: "1471383327500481391" },
    {
      raw: '{"allowFrom":[-1471383327500481391]}',
      strictJson: true,
      literal: "-1471383327500481391",
    },
  ])("rejects $raw, which would be saved as a different number", ({ raw, strictJson, literal }) => {
    expect(() => parseConfigSetValue(raw, strictJson)).toThrow(
      `${literal} is too large to store exactly`,
    );
  });

  it("keeps quoted long ids and numbers that are stored as written", () => {
    // 2^54 and the already-rounded id are stored exactly as written, so nothing changes.
    expect(
      parseConfigSetValue(
        `["1471383327500481391", 18014398509481984, 1471383327500481300, -1001234567890] // 1471383327500481391`,
        false,
      ),
    ).toEqual(["1471383327500481391", 18014398509481984, 1471383327500481300, -1001234567890]);
  });

  it("rejects overflow exponent in strict JSON mode with the finite-number error", () => {
    expect(() => parseConfigSetValue("1e999", true)).toThrow("Value must be a finite number");
  });

  it("still reports JSON parse errors in strict JSON mode", () => {
    expect(() => parseConfigSetValue("not-json", true)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Could not parse "not-json" as JSON for --strict-json.'),
        cause: expect.any(SyntaxError),
      }),
    );
  });

  it("merges deeply nested object values without an engine failure", () => {
    const depth = 20_000;
    const root = { value: nestedRecord(depth, { retained: true }) };

    mergeAtPath(root, ["value"], nestedRecord(depth, { added: true }));

    let cursor: unknown = root.value;
    for (let index = 0; index < depth; index += 1) {
      if (!isRecord(cursor)) {
        throw new Error(`missing nested record at depth ${index}`);
      }
      cursor = cursor.nested;
    }
    expect(cursor).toEqual({ retained: true, added: true });
  });
});
