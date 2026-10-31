import { describe, expect, it } from "vitest";
import { formatErrorMessageWithCauses, toErrorObject } from "../../scripts/lib/error-format.mts";

describe("toErrorObject", () => {
  it("retains Error identity and diagnostics for parsed prototype fields", () => {
    const value: unknown = JSON.parse(
      '{"__proto__":{"tag":"remote"},"message":"unavailable","code":"E_UPSTREAM","status":503}',
    );
    const detail = Symbol("detail");
    Object.defineProperty(value, detail, { value: "symbol detail", enumerable: true });

    const error = toErrorObject(value, "request failed");

    expect(error instanceof Error).toBe(true);
    expect(Object.getPrototypeOf(error)).toBe(Error.prototype);
    expect(error).toMatchObject({ message: "unavailable", code: "E_UPSTREAM", status: 503 });
    expect(error.cause).toBe(value);
    expect(Reflect.get(error, detail)).toBe("symbol detail");
  });

  it("propagates an enumerable prototype getter failure", () => {
    const failure = new Error("cannot read prototype detail");
    const value = Object.defineProperty({}, "__proto__", {
      enumerable: true,
      get() {
        throw failure;
      },
    });

    expect(() => toErrorObject(value, "request failed")).toThrow(failure);
  });
});

describe("formatErrorMessageWithCauses", () => {
  it("renders the nested transport cause attached by a read owner", () => {
    const transport = new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    const readback = new TypeError("fetch failed", { cause: transport });
    const failure = new Error(
      "https://registry.npmjs.org/openclaw: readback failed. Retry readback, not publication.",
      { cause: readback },
    );

    expect(formatErrorMessageWithCauses(failure)).toBe(
      "https://registry.npmjs.org/openclaw: readback failed. Retry readback, not publication.\n" +
        "Caused by: fetch failed\n" +
        "Caused by: getaddrinfo ENOTFOUND registry.npmjs.org",
    );
  });

  it("bounds cyclic cause chains", () => {
    const failure = new Error("outer");
    failure.cause = failure;

    expect(formatErrorMessageWithCauses(failure)).toBe("outer");
  });
});
