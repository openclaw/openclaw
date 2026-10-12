// Verifies the write-path serializer stays byte-identical to the platform
// `JSON.stringify(value, null, 2)` output across shapes the config writer can
// produce, and stays stack-safe on deeply nested documents where the platform
// serializer overflows its call stack.
import { describe, expect, it } from "vitest";
import { serializeConfigJson } from "./config-json-serialize.js";

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

describe("serializeConfigJson", () => {
  it("matches the platform serializer on scalar and shallow values", () => {
    const samples: unknown[] = [
      {},
      [],
      { a: 1 },
      [1, 2, 3],
      { a: { b: { c: [1, { d: "e" }] } } },
      "plain",
      "",
      42,
      -0,
      0.1 + 0.2,
      1e21,
      1e-7,
      123456789.12345678,
      true,
      false,
      null,
      [null],
      { nested: null, empty: {}, list: [] },
      { "quoted-key": 1, "with space": 2, "": 3 },
      { unicode: "中文 emoji", quote: 'say "hi"', backslash: "a\\b" },
      { control: "tab\there\nnewline\rcarriage\f\bzero" },
    ];
    for (const sample of samples) {
      expect(serializeConfigJson(sample as object)).toBe(JSON.stringify(sample, null, 2));
    }
  });

  it("keeps numeric-key ordering identical to the platform serializer", () => {
    const sample: Record<string, unknown> = { b: 1, "3": 2, "1": 3, a: 4 };
    expect(serializeConfigJson(sample)).toBe(JSON.stringify(sample, null, 2));
  });

  it("drops object members with unserializable values and nulls array holes", () => {
    const sample: Record<string, unknown> = { keep: 1, gone: undefined };
    const arraySample: unknown[] = ["kept", undefined];
    expect(serializeConfigJson(sample)).toBe(JSON.stringify(sample, null, 2));
    expect(serializeConfigJson(arraySample)).toBe(JSON.stringify(arraySample, null, 2));
  });

  it("escapes lone surrogates exactly like the platform serializer", () => {
    const sample = { lone: "\ud800", pair: "rocket surrogate pair", mixed: "\ud800\ud800\udc00" };
    expect(serializeConfigJson(sample)).toBe(JSON.stringify(sample, null, 2));
  });

  it("matches the platform serializer across randomized documents", () => {
    // Deterministic seed so failures reproduce.
    let state = 0x2f6e2b1;
    const nextRandom = (): number => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(nextRandom() * items.length)]!;
    const leafValues: readonly unknown[] = [
      "text",
      "",
      'with "quote" and \\backslash\\',
      "中文\n\ttab",
      0,
      -0,
      1.5,
      -1234.5678,
      1e21,
      1e-7,
      true,
      false,
      null,
      "surrogate \ud800 escape",
    ];
    const buildNode = (depth: number): unknown => {
      if (depth <= 0 || nextRandom() < 0.3) {
        return pick(leafValues);
      }
      if (nextRandom() < 0.5) {
        const object: Record<string, unknown> = {};
        const count = 1 + Math.floor(nextRandom() * 4);
        for (let index = 0; index < count; index += 1) {
          const key = pick(["alpha", "beta", "gamma", "3", "10", "2", "with space", "中文键"]);
          object[key] = nextRandom() < 0.08 ? undefined : buildNode(depth - 1);
        }
        return object;
      }
      const items: unknown[] = [];
      const count = 1 + Math.floor(nextRandom() * 4);
      for (let index = 0; index < count; index += 1) {
        items.push(nextRandom() < 0.08 ? undefined : buildNode(depth - 1));
      }
      return items;
    };
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const document = buildNode(6);
      expect(serializeConfigJson(document as object)).toBe(JSON.stringify(document, null, 2));
    }
  });

  it("serializes a deeply nested document without a call-stack overflow", () => {
    const depth = 5_000;
    const deep = buildNestedObject(depth, { leaf: "value" });
    expect(measureObjectDepth(deep)).toBe(depth);
    const serialized = serializeConfigJson(deep);
    expect(serialized.startsWith('{\n  "level": {\n')).toBe(true);
    expect(serialized).toContain('"leaf": "value"');
  });

  it("serializes deeply nested arrays without a call-stack overflow", () => {
    let value: unknown = ["leaf"];
    for (let i = 0; i < 5_000; i += 1) {
      value = [value];
    }
    const serialized = serializeConfigJson(value as object);
    expect(serialized.startsWith("[\n  [\n")).toBe(true);
    expect(serialized).toContain('"leaf"');
  });
});
