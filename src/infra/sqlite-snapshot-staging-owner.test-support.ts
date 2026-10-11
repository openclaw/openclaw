import type { createDeferredCore } from "../shared/deferred.js";

export async function waitForGate(
  gate: { entered: ReturnType<typeof createDeferredCore<void>> },
  request: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    gate.entered.promise,
    request.then(() => {
      throw new Error("Snapshot request settled before its retained release barrier");
    }),
  ]);
}
