import { validateUpdateRecoveryCleanupParams } from "../../../packages/gateway-protocol/src/index.js";
import {
  cleanupGatewayRecovery,
  cleanupGatewayUpdateRecovery,
} from "../update-automatic-cleanup.js";
import {
  captureLocalStateMutationGuard,
  localStateOwnerChangedError,
} from "./local-state-owner.js";
import { defineValidatedGatewayHandler } from "./validation.js";

export const updateRecoveryCleanupHandler = defineValidatedGatewayHandler(
  "update.recovery.cleanup",
  validateUpdateRecoveryCleanupParams,
  async (request) => {
    const assertCurrent = captureLocalStateMutationGuard(request.params.expectedOwnerId, request);
    const result =
      "runId" in request.params
        ? await cleanupGatewayUpdateRecovery(request.params.runId, process.env, assertCurrent)
        : await cleanupGatewayRecovery(request.params.dryRun === true, process.env, assertCurrent);
    request.respond(true, result ?? null);
  },
  localStateOwnerChangedError,
);
