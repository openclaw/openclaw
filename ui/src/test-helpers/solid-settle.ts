import { flush } from "solid-js";
import { waitForFast } from "./wait-for.ts";

export { flush } from "solid-js";

export function waitForSolid<T>(
  assertion: () => T | Promise<T>,
  options?: Parameters<typeof waitForFast>[1],
) {
  return waitForFast(() => {
    flush();
    return assertion();
  }, options);
}
