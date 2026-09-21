// Verifies the read-path include pre-scan stays stack-safe on deeply nested
// documents: include resolution runs first on every config load, and the
// include-aware guards that consult this scan run after it, so document
// nesting must cost heap rather than call frames.
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

function measureObjectDepth(value: unknown): number {
  let deepest = 0;
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      continue;
    }
    if (Array.isArray(entry.node)) {
      for (const item of entry.node) {
        stack.push({ node: item, depth: entry.depth + 1 });
      }
      continue;
    }
    if (typeof entry.node !== "object" || entry.node === null) {
      continue;
    }
    deepest = Math.max(deepest, entry.depth);
    for (const child of Object.values(entry.node)) {
      stack.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return deepest;
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
    expect(measureObjectDepth(deep)).toBe(100_000);
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
