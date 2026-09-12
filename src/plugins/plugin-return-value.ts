import { types } from "node:util";

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
