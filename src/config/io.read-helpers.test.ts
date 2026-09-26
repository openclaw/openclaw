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
  it("reports shallow directives and non-object values without traversal", () => {
    expect(containsConfigIncludeDirective({ [INCLUDE_KEY]: "./base.json5" })).toBe(true);
    expect(containsConfigIncludeDirective({ gateway: { [INCLUDE_KEY]: ["./a.json"] } })).toBe(true);
    expect(containsConfigIncludeDirective("plain string")).toBe(false);
    expect(containsConfigIncludeDirective(42)).toBe(false);
    expect(containsConfigIncludeDirective(null)).toBe(false);
    expect(containsConfigIncludeDirective({ gateway: { port: 1 } })).toBe(false);
  });

  it("scans a deeply nested object without include directives", () => {
    const deep = buildNestedObject(100_000, { leaf: "value" });
    expect(containsConfigIncludeDirective(deep)).toBe(false);
  });

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
