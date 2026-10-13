import {
  ErrorCodes,
  errorShape,
  validateSessionPortalCloseParams,
  validateSessionPortalListParams,
  validateSessionPortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  createPortalOperations,
  redactPortalSummary,
  type GatewayPortalService,
} from "../portals/portal-service.js";
import { captureSessionPortalTarget } from "../worker-environments/session-portal-target.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

function sessionPortalOwner(options: GatewayRequestHandlerOptions, environmentId: string) {
  const access = options.sessionAccessAuthority;
  const environments = options.context.workerEnvironmentService;
  const service = options.context.portalService;
  if (!access || !environments || !service) {
    throw new Error("Session preview authority or transport is unavailable");
  }
  if (access.sandboxRequired) {
    throw new Error(
      "This conversation requires sandbox isolation; attached machine previews are unavailable",
    );
  }
  const target = captureSessionPortalTarget(
    environments,
    {
      ...access.target,
      sessionLifecycleRevision: access.target.lifecycleRevision,
    },
    environmentId,
  );
  const assertInvocationCurrent = () => {
    access.assertCurrent();
    target.assertCurrent();
  };
  assertInvocationCurrent();
  const { binding } = target;
  const resourceOwnerKey = JSON.stringify([
    binding.agentId,
    binding.sessionKey,
    binding.sessionId,
    binding.sessionLifecycleRevision ?? null,
    binding.generation,
  ]);
  return createPortalOperations(
    service,
    {
      ...binding,
      resourceOwnerKey,
      assertCurrent: assertInvocationCurrent,
      ownershipError: "Portal does not belong to this conversation's attached environment",
      async prepareTarget(remotePort) {
        await target.touch();
        assertInvocationCurrent();
        const session = access.retainSession();
        try {
          session.assertCurrent();
          const connection = await environments.openNodePortal({
            environmentId: binding.environmentId,
            ownerEpoch: binding.ownerEpoch,
            remotePort,
          });
          return {
            assertCurrent: () => session.assertCurrent(),
            ownerSignal: AbortSignal.any([session.signal, target.signal]),
            // Bearer connections retain resource authority, not the initiating actor or turn.
            connect: () =>
              connection.connect(() => {
                session.assertCurrent();
                target.assertCurrent();
              }, target.touch),
            close: async () => {
              try {
                await connection.close();
              } finally {
                session.release();
              }
            },
          };
        } catch (error) {
          session.release();
          throw error;
        }
      },
    },
    () => broadcastPortalChange(options.context, service),
  );
}

function sessionPortalError(error: unknown) {
  return errorShape(
    ErrorCodes.INVALID_REQUEST,
    error instanceof Error ? error.message : "Session preview request failed",
  );
}

export function broadcastPortalChange(
  context: Pick<GatewayRequestHandlerOptions["context"], "broadcast">,
  service: GatewayPortalService,
) {
  // Keep bearer credentials out of broad events. Existing authorized clients refetch them.
  context.broadcast(
    "portal.changed",
    {
      portals: service.list().map(redactPortalSummary),
    },
    { dropIfSlow: true },
  );
}

export const sessionPortalHandlers: GatewayRequestHandlers = {
  "portal.session.list": defineValidatedGatewayMethod(
    "portal.session.list",
    validateSessionPortalListParams,
    (options) => {
      const portals = sessionPortalOwner(options, options.params.environmentId);
      options.respond(true, portals.list());
    },
    sessionPortalError,
  ),
  "portal.session.open": defineValidatedGatewayMethod(
    "portal.session.open",
    validateSessionPortalOpenParams,
    async (options) => {
      const portals = sessionPortalOwner(options, options.params.environmentId);
      options.respond(true, await portals.open(options.params));
    },
    sessionPortalError,
  ),
  "portal.session.close": defineValidatedGatewayMethod(
    "portal.session.close",
    validateSessionPortalCloseParams,
    async (options) => {
      const portals = sessionPortalOwner(options, options.params.environmentId);
      options.respond(true, await portals.close(options.params.id));
    },
    sessionPortalError,
  ),
};
