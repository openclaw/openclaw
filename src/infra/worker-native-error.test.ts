import { expect, it } from "vitest";
import { decodeNativeWorkerFailure, encodeNativeWorkerFailure } from "./worker-native-error.js";

const roundTrip = (error: Error) =>
  decodeNativeWorkerFailure(structuredClone(encodeNativeWorkerFailure(error)));

it("preserves native types, shared failure references and suppressed cycles", () => {
  const shared = new TypeError("resource failed");
  const failure = new SuppressedError(shared, undefined, "disposal failed");
  failure.suppressed = new SuppressedError(shared, failure, "nested disposal failed");
  const recovered = roundTrip(failure) as SuppressedError;
  const nested = recovered.suppressed as SuppressedError;
  expect(recovered).toBeInstanceOf(SuppressedError);
  expect(recovered.error).toMatchObject({ constructor: TypeError, message: "resource failed" });
  expect(nested.error).toBe(recovered.error);
  expect(nested.suppressed).toBe(recovered);
});

it.each([
  [0, 0],
  [null, null],
  [undefined, undefined],
  [{ detail: "worker context" }, '{"detail":"worker context"}'],
  [() => undefined, "[object Function]"],
  [Symbol("worker context"), "[object Symbol]"],
])("preserves downlevel suppressed diagnostics: %s", (suppressed, expected) => {
  const failure = Object.assign(new Error(), { error: new Error("cleanup failed"), suppressed });
  failure.name = "SuppressedError";
  const recovered = roundTrip(failure) as SuppressedError;
  expect(recovered.name).toBe("SuppressedError");
  expect(recovered.error).toMatchObject({ message: "cleanup failed" });
  expect(recovered.suppressed).toBe(expected);
  expect(Object.hasOwn(recovered, "suppressed")).toBe(true);
});
