import {
  ErrorCodes,
  errorShape,
  validateSystemAgentSetupActivateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import {
  runExclusiveSystemAgentSetupActivation,
  respondSetupAdmissionBusy,
  SetupAdmissionBusyError,
} from "./setup-admission.js";
import {
  activateGatewaySetupInference,
  createSystemAgentGatewayRuntime,
} from "./system-agent-execution.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const activateSetupHandler = defineValidatedGatewayHandler(
  "openclaw.setup.activate",
  validateSystemAgentSetupActivateParams,
  async (options) => {
    const { respond } = options;
    const { expectedOwnerId, activationConfirmed, ...params } = options.params;
    if (expectedOwnerId || activationConfirmed) {
      if (!expectedOwnerId || !activationConfirmed || !params.kind.startsWith("saved-auth:")) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Local activation requires a confirmed saved sign-in.",
          ),
        );
        return;
      }
      try {
        captureLocalStateMutationGuard(expectedOwnerId, options);
      } catch (error) {
        respond(false, undefined, localStateOwnerChangedError(error));
        return;
      }
      const { resolveModelsTargetAgent } = await import("../../commands/models/shared.js");
      params.agentId = resolveModelsTargetAgent(
        options.context.getRuntimeConfig(),
        params.agentId,
        { kind: "mutation" },
      ).agentId;
    }
    try {
      const result = await runExclusiveSystemAgentSetupActivation(() =>
        activateGatewaySetupInference({
          ...params,
          activationConfirmed,
          signal: options.signal,
          surface: "gateway",
          runtime: createSystemAgentGatewayRuntime(),
        }),
      );
      respond(true, result, undefined);
    } catch (error) {
      if (!(error instanceof SetupAdmissionBusyError)) {
        throw error;
      }
      respondSetupAdmissionBusy(respond);
    }
  },
);
