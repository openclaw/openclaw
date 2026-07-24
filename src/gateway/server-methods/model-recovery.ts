// Gateway control-plane methods for durable new-work model diversion fences.
import {
  ErrorCodes,
  MODEL_RECOVERY_CAPABILITY_VERSION,
  MODEL_RECOVERY_DELIVERY_CAPABILITY_VERSION,
  MODEL_RECOVERY_EFFECT_CAPABILITY_VERSION,
  errorShape,
  type ModelRecoveryDivertNewParams,
  type ModelRecoveryPrepareRecoveryParams,
  type ModelRecoveryReleaseParams,
  validateModelRecoveryDivertNewParams,
  validateModelRecoveryPrepareRecoveryParams,
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

type ModelRecoveryCapabilities = {
  durableEffects: boolean;
  durableDelivery: boolean;
  submissionPermitsAtDispatch: boolean;
};

export type ModelRecoveryMutationPolicy = {
  allowedTargets: readonly {
    provider: string;
    model: string;
  }[];
};

const AVAILABLE_CAPABILITIES: ModelRecoveryCapabilities = {
  durableEffects: true,
  durableDelivery: true,
  // Fail closed until every eligible provider dispatch acquires and settles
  // the global permit added by this slice.
  submissionPermitsAtDispatch: false,
};

const DENY_ALL_MUTATIONS: ModelRecoveryMutationPolicy = {
  allowedTargets: [],
};

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
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "Model recovery capability is unavailable", {
      retryable: true,
    }),
  );
}

export function createModelRecoveryHandlers(
  store: ModelTargetFenceStore,
  capabilities: ModelRecoveryCapabilities = AVAILABLE_CAPABILITIES,
  mutationPolicy: ModelRecoveryMutationPolicy = DENY_ALL_MUTATIONS,
): GatewayRequestHandlers {
  const allowedMutationTargets = new Set(
    mutationPolicy.allowedTargets.map(({ provider, model }) => JSON.stringify([provider, model])),
  );
  const requireAllowedTarget = (
    respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
    target: { provider: string; model: string },
  ): boolean => {
    if (allowedMutationTargets.has(JSON.stringify([target.provider, target.model]))) {
      return true;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.FORBIDDEN, "Model recovery target is not allowed"),
    );
    return false;
  };
  const requireCapabilities = (
    respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  ): boolean => {
    if (
      capabilities.durableEffects &&
      capabilities.durableDelivery &&
      capabilities.submissionPermitsAtDispatch
    ) {
      return true;
    }
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "Model recovery capability is unavailable", {
        retryable: false,
      }),
    );
    return false;
  };
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
        respond(
          true,
          {
            capability: "available",
            capabilityVersion: MODEL_RECOVERY_CAPABILITY_VERSION,
            durableEffectCapabilityVersion: MODEL_RECOVERY_EFFECT_CAPABILITY_VERSION,
            durableDeliveryCapabilityVersion: MODEL_RECOVERY_DELIVERY_CAPABILITY_VERSION,
            submissionPermitCapabilityVersion: 1,
            prepareRecoveryAvailable:
              capabilities.durableEffects &&
              capabilities.durableDelivery &&
              capabilities.submissionPermitsAtDispatch,
            ...store.status(),
          },
          undefined,
        );
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
      if (!requireAllowedTarget(respond, params as ModelRecoveryDivertNewParams)) {
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
    "modelRecovery.prepareRecovery": ({ params, respond }) => {
      if (
        !assertValidParams(
          params,
          validateModelRecoveryPrepareRecoveryParams,
          "modelRecovery.prepareRecovery",
          respond,
        )
      ) {
        return;
      }
      if (!requireAllowedTarget(respond, params as ModelRecoveryPrepareRecoveryParams)) {
        return;
      }
      if (!requireCapabilities(respond)) {
        return;
      }
      try {
        const fence = store.prepareRecovery({
          ...(params as ModelRecoveryPrepareRecoveryParams),
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
      if (!requireAllowedTarget(respond, params as ModelRecoveryReleaseParams)) {
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
