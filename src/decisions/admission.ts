import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { DecisionContractError } from "./validation.js";

/** Latch consumer withdrawal or invalid admission for the lifetime of one evaluation. */
export function createDecisionAdmission(admit: (() => boolean) | undefined): () => boolean {
  let allowed = true;
  let failure: DecisionContractError | undefined;
  return () => {
    if (failure) {
      throw failure;
    }
    if (!allowed || !admit) {
      return allowed;
    }
    try {
      const result: unknown = admit();
      // Invalid async callbacks must not leak late unhandled rejections.
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch(() => undefined);
      }
      if (typeof result !== "boolean") {
        throw new DecisionContractError();
      }
      allowed = result;
      return allowed;
    } catch {
      // Providers can translate transport errors; retain the original contract failure.
      failure = new DecisionContractError();
      throw failure;
    }
  };
}
