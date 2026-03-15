import { describe, expect, it } from "vitest";
import { safeJsonStringify } from "./safe-json.js";

describe("safeJsonStringify", () => {
  // -- replacer branches ------------------------------------------------

  it("converts bigint values to strings", () => {
    const result = safeJsonStringify({ n: 42n, zero: 0n, neg: -1n });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as Record<string, unknown>;

    expect(parsed.n).toBe("42");
    expect(parsed.zero).toBe("0");
    expect(parsed.neg).toBe("-1");
  });

  it("replaces functions with the sentinel string", () => {
    const result = safeJsonStringify({
      arrow: () => "ok",
      named: function hello() {},
    });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as Record<string, unknown>;

    expect(parsed.arrow).toBe("[Function]");
    expect(parsed.named).toBe("[Function]");
  });

  it("serializes Error instances into plain objects", () => {
    const err = new TypeError("boom");
    const result = safeJsonStringify({ err });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as { err: Record<string, unknown> };

    expect(parsed.err).toMatchObject({ name: "TypeError", message: "boom" });
    expect(parsed.err.stack).toEqual(expect.any(String));
  });

  it("serializes Uint8Array to base64 envelope", () => {
    const bytes = new Uint8Array([0, 255, 16, 32]);
    const result = safeJsonStringify({ bytes });
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as { bytes: Record<string, unknown> };

    expect(parsed.bytes).toEqual({
      type: "Uint8Array",
      data: Buffer.from(bytes).toString("base64"),
    });
  });

  it("handles empty Uint8Array", () => {
    const result = safeJsonStringify({ bytes: new Uint8Array([]) });
    const parsed = JSON.parse(result!) as { bytes: Record<string, unknown> };

    expect(parsed.bytes).toEqual({ type: "Uint8Array", data: "" });
  });

  // -- pass-through (default `return val`) --------------------------------

  it("passes through plain JSON-safe values unchanged", () => {
    const input = {
      str: "hello",
      num: 42,
      float: 3.14,
      bool: true,
      nil: null,
      arr: [1, "two", false],
      nested: { a: { b: 1 } },
    };
    const result = safeJsonStringify(input);

    expect(result).toBe(JSON.stringify(input));
  });

  // -- top-level primitives -----------------------------------------------

  it("serializes top-level string", () => {
    expect(safeJsonStringify("hello")).toBe('"hello"');
  });

  it("serializes top-level number", () => {
    expect(safeJsonStringify(42)).toBe("42");
  });

  it("serializes top-level null", () => {
    expect(safeJsonStringify(null)).toBe("null");
  });

  it("serializes top-level boolean", () => {
    expect(safeJsonStringify(true)).toBe("true");
  });

  it("returns undefined (as string) for top-level undefined", () => {
    // JSON.stringify(undefined) returns undefined (not "null"), which our
    // wrapper passes through; callers should guard against this.
    expect(safeJsonStringify(undefined)).toBeUndefined();
  });

  // -- nested / mixed special types ---------------------------------------

  it("handles special types nested inside arrays", () => {
    const result = safeJsonStringify([42n, new TypeError("oops"), () => {}]);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as unknown[];

    expect(parsed[0]).toBe("42");
    expect(parsed[1]).toMatchObject({ name: "TypeError", message: "oops" });
    expect(parsed[2]).toBe("[Function]");
  });

  it("handles deeply nested special types", () => {
    const result = safeJsonStringify({
      level1: { level2: { val: 99n } },
    });
    const parsed = JSON.parse(result!) as { level1: { level2: { val: string } } };

    expect(parsed.level1.level2.val).toBe("99");
  });

  // -- undefined / Symbol key behavior ------------------------------------

  it("drops object keys whose values are undefined (standard JSON behavior)", () => {
    const result = safeJsonStringify({ present: 1, gone: undefined });
    const parsed = JSON.parse(result!) as Record<string, unknown>;

    expect(parsed).toEqual({ present: 1 });
    expect("gone" in parsed).toBe(false);
  });

  it("drops Symbol-keyed properties (standard JSON behavior)", () => {
    const sym = Symbol("secret");
    const result = safeJsonStringify({ visible: true, [sym]: "hidden" });
    const parsed = JSON.parse(result!) as Record<string, unknown>;

    expect(parsed).toEqual({ visible: true });
  });

  // -- error paths (catch block) ------------------------------------------

  it("returns null for circular structures", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(safeJsonStringify(circular)).toBeNull();
  });

  it("returns null when toJSON() throws", () => {
    const value = {
      toJSON() {
        throw new Error("explode");
      },
    };

    expect(safeJsonStringify(value)).toBeNull();
  });

  // -- combined object (integration-style) --------------------------------

  it("serializes an object mixing all special types at once", () => {
    const bytes = new Uint8Array([0xca, 0xfe]);
    const err = new RangeError("out of bounds");
    const fn = () => "noop";

    const result = safeJsonStringify({
      id: 1,
      big: 9007199254740993n,
      fn,
      err,
      bytes,
      tags: ["a", "b"],
    });

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!) as Record<string, unknown>;

    expect(parsed.id).toBe(1);
    expect(parsed.big).toBe("9007199254740993");
    expect(parsed.fn).toBe("[Function]");
    expect(parsed.err).toMatchObject({ name: "RangeError", message: "out of bounds" });
    expect(parsed.bytes).toEqual({
      type: "Uint8Array",
      data: Buffer.from(bytes).toString("base64"),
    });
    expect(parsed.tags).toEqual(["a", "b"]);
  });
});
