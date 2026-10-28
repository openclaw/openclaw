import { types } from "node:util";

const promiseThen = Object.getOwnPropertyDescriptor(Promise.prototype, "then");
const promiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species);

/** Preserve foreign then/species results while identifying native host continuations. */
export function mapPluginReturnPromise(
  completion: Promise<unknown>,
  fulfilled: (value: unknown) => unknown,
  rejected?: (error: unknown) => unknown,
) {
  // oxlint-disable-next-line typescript/unbound-method -- Preserve method identity; Reflect.apply below supplies the exact original receiver.
  const then = completion.then;
  // Capture then first: a plugin getter can replace the constructor or species.
  const constructor =
    types.isPromise(completion) && Object.getPrototypeOf(completion) === Promise.prototype
      ? (Object.getOwnPropertyDescriptor(completion, "constructor") ??
        Object.getOwnPropertyDescriptor(Promise.prototype, "constructor"))
      : undefined;
  const host =
    then === promiseThen?.value &&
    constructor?.value === Promise &&
    Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get === promiseSpecies?.get;
  const value: Promise<unknown> = Reflect.apply(
    then,
    completion,
    rejected ? [fulfilled, rejected] : [fulfilled],
  );
  return { value, host };
}

/** Capture a returned then method once without turning synchronous values into async work. */
export function resolvePluginReturnPromise(value: unknown): Promise<unknown> | undefined {
  if (types.isPromise(value)) {
    return Promise.resolve(value);
  }
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  let then: unknown;
  try {
    then = Reflect.get(value, "then");
  } catch (error) {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Native resolution preserves the exact getter rejection, including non-Error values.
    return Promise.reject(error);
  }
  if (typeof then !== "function") {
    return undefined;
  }
  return Promise.resolve({
    // oxlint-disable-next-line unicorn/no-thenable -- Native assimilation calls the captured method once with its original receiver.
    then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      Reflect.apply(then, value, [resolve, reject]);
    },
  });
}
