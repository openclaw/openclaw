import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import {
  projectWorkerSessionPlacement,
  readWorkerPlacementIdentity,
} from "../worker-environments/placement-projector.js";
import { isWorkerDispatchInputError } from "./sessions-shared.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

export function respondWorkerPlacement(params: {
  respond: RespondFn;
  key: string;
  sessionId: string;
  context: GatewayRequestContext;
  placement: Parameters<typeof projectWorkerSessionPlacement>[0];
}): void {
  params.respond(
    true,
    {
      ok: true,
      key: params.key,
      sessionId: params.sessionId,
      placement: projectWorkerSessionPlacement(
        params.placement,
        params.context.workerPlacementDiskSpaceReader?.read(params.placement),
        // Canonical fenced runner reader; a node lost after durable provision
        // must project offline here exactly as sessions.list would.
        params.context.workerPlacementRunnerAvailabilityReader?.read(params.placement),
        readWorkerPlacementIdentity(params.placement, params.context.workerEnvironmentService),
      ),
    },
    undefined,
  );
}

export function respondWorkerDispatchError(error: unknown, respond: RespondFn): void {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    throw error;
  }
  respond(
    false,
    undefined,
    errorShape(
      isWorkerDispatchInputError(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      formatErrorMessage(error),
    ),
  );
}
