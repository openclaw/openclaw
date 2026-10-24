import { describe, expect, it } from "vitest";
import { toErrorObject } from "../packages/normalization-core/src/error-coercion.js";
import { toRetryError } from "../packages/retry/src/index.js";
import { toLintErrorObject } from "../scripts/lib/bounded-response.mjs";
import { toErrorObject as toScriptErrorObject } from "../scripts/lib/error-format.mts";

// Retry stays dependency-free and bootstrap scripts run without workspace packages.
// Their independent coercers must preserve the same diagnostic assignment contract.
describe.each([
  { name: "normalizer", coerce: toErrorObject },
  { name: "retry", coerce: toRetryError },
  { name: "bootstrap script", coerce: toScriptErrorObject },
  { name: "bounded response script", coerce: toLintErrorObject },
])("$name error coercion", ({ coerce }) => {
  it("retains Error identity and diagnostic fields from parsed JSON", () => {
    const payload: unknown = JSON.parse(
      '{"__proto__":{"tag":"fixture"},"code":"E_UPSTREAM","status":503}',
    );
    const error = coerce(payload, "upstream failed");

    expect(error instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(error) === Error.prototype).toBe(true);
    expect(error.cause).toBe(payload);
    expect(error).toMatchObject({ message: "upstream failed", code: "E_UPSTREAM", status: 503 });
    expect(Object.hasOwn(error, "__proto__")).toBe(false);
    expect(Object.hasOwn(Object.prototype, "tag")).toBe(false);
  });

  it("keeps ordinary assignment semantics for Error-owned and diagnostic fields", () => {
    const detail = Symbol("detail");
    const payload = {
      message: "upstream message",
      cause: "upstream cause",
      stack: "upstream stack",
      constructor: "diagnostic constructor",
      prototype: "diagnostic prototype",
      [detail]: "symbol detail",
    };
    Object.defineProperty(payload, "hidden", {
      get() {
        throw new Error("non-enumerable field was read");
      },
    });
    const error = coerce(payload, "fallback");

    expect(error).toMatchObject(payload);
    for (const key of ["message", "cause", "stack"]) {
      expect(Object.getOwnPropertyDescriptor(error, key)).toMatchObject({
        enumerable: false,
        configurable: true,
      });
    }
    expect(Reflect.get(error, detail)).toBe("symbol detail");
    expect(Object.getOwnPropertyDescriptor(error, detail)?.enumerable).toBe(true);
    expect(Object.hasOwn(error, "hidden")).toBe(false);
  });

  it("checks each field's current enumerability and reads getters in assignment order", () => {
    const reads: string[] = [];
    const detail = Symbol("detail");
    const payload = { first: "unused", later: "must be skipped" };
    Object.defineProperty(payload, "first", {
      enumerable: true,
      get() {
        reads.push("first");
        Object.defineProperty(payload, "later", { enumerable: false });
        return "first value";
      },
    });
    Object.defineProperty(payload, "__proto__", {
      enumerable: true,
      get() {
        reads.push("proto");
        return { tag: "fixture" };
      },
    });
    Object.defineProperty(payload, detail, {
      enumerable: true,
      get() {
        reads.push("symbol");
        return "symbol value";
      },
    });

    const error = coerce(payload, "fallback");
    expect(reads).toEqual(["first", "proto", "symbol"]);
    expect(error instanceof Error).toBe(true);
    expect(error).toHaveProperty("first", "first value");
    expect(Object.hasOwn(error, "later")).toBe(false);
    expect(Reflect.get(error, detail)).toBe("symbol value");
  });

  it.each(["__proto__", "code"])("propagates a throwing enumerable %s getter", (key) => {
    const failure = new Error("diagnostic getter failed");
    const payload = Object.defineProperty({}, key, {
      enumerable: true,
      get() {
        throw failure;
      },
    });
    expect(() => coerce(payload, "fallback")).toThrow(failure);
  });

  it.each(["__proto__", "code"])("propagates a throwing %s descriptor lookup", (key) => {
    const failure = new Error("diagnostic descriptor failed");
    const payload = new Proxy(
      Object.defineProperty({}, key, { enumerable: true, configurable: true, value: "detail" }),
      {
        getOwnPropertyDescriptor() {
          throw failure;
        },
      },
    );
    expect(() => coerce(payload, "fallback")).toThrow(failure);
  });
});
