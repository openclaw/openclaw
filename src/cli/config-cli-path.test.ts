import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { mergeAtPath, parseConfigSetValue, setAtPath } from "./config-cli-path.js";

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
    { raw: "3.14", expected: 3.14 },
    { raw: "-0", expected: -0 },
    { raw: "true", expected: true },
    { raw: "false", expected: false },
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
    { raw: "-Infinity", label: "negative Infinity" },
    { raw: "NaN", label: "NaN" },
    { raw: "1e999", label: "overflow exponent" },
    { raw: "{timeout:1e999}", label: "object with overflow exponent" },
    { raw: "[1e999]", label: "array with overflow exponent" },
  ])("rejects $label in value mode", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, false)).toThrow("Value must be a finite number");
  });

  it("rejects overflow exponent in strict JSON mode with the finite-number error", () => {
    expect(() => parseConfigSetValue("1e999", true)).toThrow("Value must be a finite number");
  });

  it.each([
    { raw: "Infinity", label: "Infinity" },
    { raw: "-Infinity", label: "negative Infinity" },
    { raw: "NaN", label: "NaN" },
  ])("rejects $label in strict JSON mode as invalid JSON", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, true)).toThrow();
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

describe("setAtPath array bounds", () => {
  it("rejects an out-of-range nested array index instead of writing a sparse null hole", () => {
    const root = { items: [{ id: "a" }, { id: "b" }] };
    expect(() => setAtPath(root, ["items", "5", "name"], "x")).toThrow(
      'Cannot set array index 5; array "items" has 2 element(s). Use index 2 to append or a lower index to update.',
    );
    expect(root.items).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("rejects an out-of-range leaf array index instead of writing a sparse null hole", () => {
    const root = { items: [{ id: "a" }] };
    expect(() => setAtPath(root, ["items", "3"], { name: "y" })).toThrow(
      'Cannot set array index 3; array "items" has 1 element(s). Use index 1 to append or a lower index to update.',
    );
    expect(root.items).toEqual([{ id: "a" }]);
  });

  it("allows appending at the exact current length without a null hole", () => {
    const root = { items: [{ id: "a" }, { id: "b" }] };
    setAtPath(root, ["items", "2", "name"], "append");
    expect(structuredClone(root.items)).toEqual([{ id: "a" }, { id: "b" }, { name: "append" }]);
  });

  it("allows the first element into an empty array", () => {
    const root = { list: [] };
    setAtPath(root, ["list", "0", "id"], "first");
    expect(structuredClone(root.list)).toEqual([{ id: "first" }]);
  });

  it("allows in-bounds writes", () => {
    const root = { items: [{ id: "a" }, { id: "b" }] };
    setAtPath(root, ["items", "0", "name"], "overwrite");
    expect(root.items).toEqual([{ id: "a", name: "overwrite" }, { id: "b" }]);
  });
});
