// Gateway control-plane methods for durable new-work model diversion fences.
import {
  ErrorCodes,
  errorShape,
  type ModelRecoveryDivertNewParams,
  type ModelRecoveryReleaseParams,
  validateModelRecoveryDivertNewParams,
  validateModelRecoveryReleaseParams,
  validateModelRecoveryStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { invalidateModelTargetFenceSnapshot } from "../../agents/model-target-fence-qualification.js";
import {
  createModelTargetFenceStore,
  ModelTargetFenceConflictError,
  ModelTargetFenceStaleError,
  type ModelTargetFenceStore,
} from "../../state/model-target-fence-store.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondStoreError(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  error: unknown,
): void {
  if (
    error instanceof ModelTargetFenceStaleError ||
    error instanceof ModelTargetFenceConflictError
  ) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
    return;
  }
  respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(error), { retryable: true }));
}

export function createModelRecoveryHandlers(store: ModelTargetFenceStore): GatewayRequestHandlers {
  return {
    "modelRecovery.status": ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateModelRecoveryStatusParams,
          "modelRecovery.status",
          respond,
        )
      ) {
        return;
      }
      try {
        respond(true, { capability: "available", ...store.status() }, undefined);
      } catch (error) {
        respondStoreError(respond, error);
      }
    },
    "modelRecovery.divertNew": ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateModelRecoveryDivertNewParams,
          "modelRecovery.divertNew",
          respond,
        )
      ) {
        return;
      }
      try {
        const fence = store.divertNew({
          ...(params as ModelRecoveryDivertNewParams),
          nowMs: Date.now(),
        });
        invalidateModelTargetFenceSnapshot();
        respond(true, fence, undefined);
      } catch (error) {
        respondStoreError(respond, error);
      }
    },
    "modelRecovery.release": ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateModelRecoveryReleaseParams,
          "modelRecovery.release",
          respond,
        )
      ) {
        return;
      }
      try {
        const fence = store.release({
          ...(params as ModelRecoveryReleaseParams),
          nowMs: Date.now(),
        });
        invalidateModelTargetFenceSnapshot();
        respond(true, fence, undefined);
      } catch (error) {
        respondStoreError(respond, error);
      }
    },
  };
}

export const modelRecoveryHandlers = createModelRecoveryHandlers(createModelTargetFenceStore());
