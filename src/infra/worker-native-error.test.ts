import { describe, expect, it } from "vitest";
import { decodeNativeWorkerFailure, encodeNativeWorkerFailure } from "./worker-native-error.js";

const roundTrip = (error: Error) =>
  decodeNativeWorkerFailure(structuredClone(encodeNativeWorkerFailure(error)));

describe("native worker errors", () => {
  it.each([
    { name: "object", cause: { detail: "worker context" }, text: '{"detail":"worker context"}' },
    { name: "function", cause: () => undefined, text: "[object Function]" },
    { name: "symbol", cause: Symbol("worker context"), text: "[object Symbol]" },
  ])("renders non-Error $name causes as cloneable diagnostics", ({ cause, text }) => {
    expect(roundTrip(new Error("worker failed", { cause }))).toMatchObject({
      message: "worker failed",
      cause: text,
    });
  });

  it("preserves native type and shared failure references", () => {
    const shared = new TypeError("resource failed");
    const failure = new SuppressedError(shared, shared, "disposal failed");
    const recovered = roundTrip(failure);
    expect(recovered).toBeInstanceOf(SuppressedError);
    expect(recovered).toMatchObject({
      error: { message: "resource failed" },
      suppressed: { message: "resource failed" },
    });
    const suppressed = recovered as SuppressedError;
    expect(suppressed.error).toBeInstanceOf(TypeError);
    expect(suppressed.error).toBe(suppressed.suppressed);
  });

  it.each([0, null, undefined])("preserves downlevel suppressed values: %s", (suppressed) => {
    const failure = Object.assign(new Error("disposal failed"), {
      name: "SuppressedError",
      error: new Error("cleanup failed"),
      suppressed,
    });
    const recovered = roundTrip(failure);
    expect(recovered).toMatchObject({
      name: "SuppressedError",
      error: { message: "cleanup failed" },
      suppressed,
    });
    expect(Object.hasOwn(recovered as Error, "suppressed")).toBe(true);
  });

  it("preserves cycles through suppressed failures", () => {
    const failure = new SuppressedError(new Error("cleanup failed"), undefined);
    failure.suppressed = failure;
    const recovered = roundTrip(failure) as SuppressedError;
    expect(recovered.suppressed).toBe(recovered);
  });
});
