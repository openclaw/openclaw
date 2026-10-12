// Covers stack-safe env-ref restoration on deeply nested documents.
import { describe, it, expect } from "vitest";
import { restoreEnvVarRefs } from "./env-preserve.js";

describe("stack-safe deep env-ref restoration", () => {
  const probeEnv = { OPENCLAW_PROBE_VAR: "resolved-value" };

  function buildNestedObject(
    depth: number,
    leaf: Record<string, unknown>,
  ): Record<string, unknown> {
    let value: Record<string, unknown> = leaf;
    for (let i = 0; i < depth; i += 1) {
      value = { level: value };
    }
    return value;
  }

  function readDeepLeaf(value: unknown, depth: number): unknown {
    let current = value;
    for (let i = 0; i < depth; i += 1) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) {
        return undefined;
      }
      current = (current as Record<string, unknown>).level;
    }
    return current;
  }

  it("restores a deep ${VAR} reference without a call-stack overflow", () => {
    const depth = 5_000;
    const parsed = buildNestedObject(depth, { leaf: "${OPENCLAW_PROBE_VAR}" });
    const incoming = buildNestedObject(depth, { leaf: "resolved-value" });
    const result = restoreEnvVarRefs(incoming, parsed, probeEnv);
    expect(readDeepLeaf(result, depth)).toEqual({ leaf: "${OPENCLAW_PROBE_VAR}" });
  });

  it("walks a deep reference-free document without a call-stack overflow", () => {
    const depth = 5_000;
    const parsed = buildNestedObject(depth, { leaf: "value" });
    const incoming = buildNestedObject(depth, { leaf: "value" });
    const result = restoreEnvVarRefs(incoming, parsed, probeEnv);
    expect(readDeepLeaf(result, depth)).toEqual({ leaf: "value" });
  });

  it("keeps deep object keys in document order", () => {
    const incoming = { a: { x: 1 }, added: "new", c: { y: 2 } };
    const parsed = { a: { x: 1 }, c: { y: 2 } };
    const result = restoreEnvVarRefs(incoming, parsed, probeEnv) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(["a", "added", "c"]);
    expect(result).toEqual(incoming);
  });
});
