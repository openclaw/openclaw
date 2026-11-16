import { expect, it } from "vitest";
import { mapNestedStrings } from "./map-nested-strings.js";

it("maps nested string values without rewriting keys or non-string leaves", () => {
  const input: unknown = JSON.parse('{"__proto__":"text","nested":[{"name":"value"},7,null,true]}');
  const result = mapNestedStrings(input, (value) => `<${value}>`);
  expect(result).toEqual({
    ["__proto__"]: "<text>",
    nested: [{ name: "<value>" }, 7, null, true],
  });
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
});

it("preserves sparse array slots", () => {
  const input = Array<string>(3);
  input[1] = "value";
  const result = mapNestedStrings(input, (value) => value.toUpperCase());
  const expected = Array<string>(3);
  expected[1] = "VALUE";
  expect(result).toStrictEqual(expected);
});
