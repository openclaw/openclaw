import type { UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

type ReceiptCallback<Value> = (value: Value) => void | Promise<void>;

export type CanaryReceiptCallbacks = {
  /** Emit at completion; replaying after the canary shifts persisted step timestamps. */
  onStep?: ReceiptCallback<UpdateStepResult>;
  onProgress?: ReceiptCallback<UpdateRunStep>;
};

export function createCanaryReceiptObserver(callbacks: CanaryReceiptCallbacks) {
  let failed = false;
  const observe = <Value>(callback: ReceiptCallback<Value> | undefined) => {
    if (!callback) {
      return undefined;
    }
    return async (value: Value) => {
      try {
        await callback(value);
      } catch (error) {
        failed = true;
        throw error;
      }
    };
  };
  return {
    onStep: observe(callbacks.onStep),
    onProgress: observe(callbacks.onProgress),
    hasFailed: () => failed,
  };
}
