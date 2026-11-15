import { raceWithTimeout } from "../../packages/retry/src/index.js";
/** A deadline bounds waiting; fulfillment alone does not certify resource cleanup. */
export async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return await raceWithTimeout(
    promise.then(() => true),
    timeoutMs,
    () => false,
    { ref: false },
  );
}
