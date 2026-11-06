import { describe, expect, it } from "vitest";
import { INCLUDE_KEY } from "./includes.js";
import { containsConfigIncludeDirective } from "./io.read-helpers.js";

function buildNestedObject(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i += 1) {
    value = { level: value };
  }
  return value;
}

describe("containsConfigIncludeDirective", () => {
  it("finds a directive buried at the bottom of a deeply nested object", () => {
    const deep = buildNestedObject(100_000, { [INCLUDE_KEY]: "./base.json5" });
    expect(containsConfigIncludeDirective(deep)).toBe(true);
  });

  it("scans deeply nested arrays without include directives", () => {
    let value: unknown = ["leaf"];
    for (let i = 0; i < 100_000; i += 1) {
      value = [value];
    }
    expect(containsConfigIncludeDirective(value)).toBe(false);
  });
});
