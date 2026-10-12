// Verifies the changed-path walk keeps its depth-first path order and its
// recursion-free traversal: document nesting costs heap rather than call
// frames, so the write path cannot overflow on a schema-valid deep config.
import { describe, expect, it } from "vitest";
import { collectChangedPaths } from "./config-change-paths.js";

// Reference implementation kept recursive on purpose: small documents only,
// mirroring the emission order the walker must preserve.
function collectRecursively(
  base: unknown,
  target: unknown,
  path: string,
  output: Set<string>,
): void {
  if (Object.is(base, target)) {
    return;
  }
  if (Array.isArray(base) && Array.isArray(target)) {
    const max = Math.max(base.length, target.length);
    for (let index = 0; index < max; index += 1) {
      const childPath = path ? `${path}[${index}]` : `[${index}]`;
      if (index >= base.length || index >= target.length) {
        output.add(childPath);
        continue;
      }
      collectRecursively(base[index], target[index], childPath, output);
    }
    return;
  }
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof target === "object" &&
    target !== null &&
    !Array.isArray(target)
  ) {
    const keys = [...new Set([...Object.keys(base), ...Object.keys(target)])];
    for (const key of keys) {
      const childPath = path ? `${path}.${key}` : key;
      const hasBase = Object.hasOwn(base, key);
      const hasTarget = Object.hasOwn(target, key);
      if (!hasTarget || !hasBase) {
        output.add(childPath);
        continue;
      }
      collectRecursively(
        (base as Record<string, unknown>)[key],
        (target as Record<string, unknown>)[key],
        childPath,
        output,
      );
    }
    return;
  }
  if (base !== target) {
    output.add(path);
  }
}

function buildNestedObject(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = leaf;
  for (let i = 0; i < depth; i += 1) {
    value = { level: value };
  }
  return value;
}

describe("collectChangedPaths", () => {
  it("matches a depth-first reference walk on shallow documents", () => {
    const base = {
      keep: 1,
      changed: { a: 1, b: [1, 2, 3] },
      removed: true,
      array: [1, { x: 1 }, "tail"],
    };
    const target = {
      keep: 1,
      changed: { a: 2, b: [1, 9, 3, 4] },
      added: "new",
      array: [1, { x: 2 }],
    };
    const walked = new Set<string>();
    const reference = new Set<string>();
    collectChangedPaths(base, target, "", walked);
    collectRecursively(base, target, "", reference);
    expect([...walked]).toEqual([...reference]);
    expect(walked.has("changed.a")).toBe(true);
    expect(walked.has("changed.b[1]")).toBe(true);
    expect(walked.has("changed.b[3]")).toBe(true);
    expect(walked.has("removed")).toBe(true);
    expect(walked.has("added")).toBe(true);
    expect(walked.has("array[1].x")).toBe(true);
    expect(walked.has("array[2]")).toBe(true);
  });

  it("reports a leaf change deep inside a nested document without overflowing", () => {
    const depth = 5_000;
    const base = buildNestedObject(depth, { leaf: "value" });
    const target = buildNestedObject(depth, { leaf: "changed" });
    const walked = new Set<string>();
    collectChangedPaths(base, target, "", walked);
    expect(walked.size).toBe(1);
    expect([...walked][0]?.endsWith(".leaf")).toBe(true);
  });

  it("reports deep array growth without overflowing", () => {
    let base: unknown = ["leaf"];
    let target: unknown = ["leaf", "appended"];
    for (let i = 0; i < 5_000; i += 1) {
      base = [base];
      target = [target];
    }
    const walked = new Set<string>();
    collectChangedPaths(base, target, "", walked);
    expect(walked.size).toBe(1);
  });
});
