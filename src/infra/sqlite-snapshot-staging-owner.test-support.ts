import {
  createRetainedOperation,
  flatMapRetainedOperation,
} from "@openclaw/worker-runtime/lifecycle";
import { vi } from "vitest";
import type { createDeferredCore } from "../shared/deferred.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

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

export function holdNativeStop(native: RetainedNativeWorker) {
  const allowed = createRetainedOperation<void>(() => {});
  const stop = native.stop.bind(native);
  const held = flatMapRetainedOperation(allowed.operation, stop);
  const spy = vi.spyOn(native, "stop").mockReturnValue(held);
  return {
    release: () => allowed.resolve(),
    restore() {
      allowed.resolve();
      spy.mockRestore();
    },
  };
}
