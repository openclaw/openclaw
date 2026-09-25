import {
  ErrorCodes,
  errorShape,
  validateSessionPortalCloseParams,
  validateSessionPortalListParams,
  validateSessionPortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
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
  return {
    ...target,
    resourceOwnerKey,
    environments,
    service,
    access,
    assertAllowed: assertInvocationCurrent,
  };
}

function fail(options: GatewayRequestHandlerOptions, error: unknown) {
  options.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      error instanceof Error ? error.message : "Session preview request failed",
    ),
  );
}

function changed(options: GatewayRequestHandlerOptions) {
  // Keep bearer credentials out of broad events. Existing authorized clients refetch them.
  options.context.broadcast(
    "portal.changed",
    {
      portals: options.context
        .portalService!.list()
        .map(({ url: _url, tokenQuery: _token, ...portal }) => portal),
    },
    { dropIfSlow: true },
  );
}

export const sessionPortalHandlers: GatewayRequestHandlers = {
  "portal.session.list": defineValidatedGatewayMethod(
    "portal.session.list",
    validateSessionPortalListParams,
    (options) => {
      try {
        const owner = sessionPortalOwner(options, options.params.environmentId);
        const portals = owner.service.listWorkerPortals(
          owner.binding.environmentId,
          owner.binding.ownerEpoch,
          owner.resourceOwnerKey,
        );
        owner.assertAllowed();
        options.respond(true, { portals });
      } catch (error) {
        fail(options, error);
      }
    },
  ),
  "portal.session.open": defineValidatedGatewayMethod(
    "portal.session.open",
    validateSessionPortalOpenParams,
    async (options) => {
      try {
        const request = options.params;
        const owner = sessionPortalOwner(options, request.environmentId);
        await owner.touch();
        owner.assertAllowed();
        const session = owner.access.retainSession();
        let connection: Awaited<ReturnType<typeof owner.environments.openNodePortal>>;
        try {
          session.assertCurrent();
          connection = await owner.environments.openNodePortal({
            environmentId: owner.binding.environmentId,
            ownerEpoch: owner.binding.ownerEpoch,
            remotePort: request.port,
          });
        } catch (error) {
          session.release();
          throw error;
        }
        const close = async () => {
          try {
            await connection.close();
          } finally {
            session.release();
          }
        };
        try {
          owner.assertAllowed();
          session.assertCurrent();
        } catch (error) {
          await close();
          throw error;
        }
        const opened = await owner.service.open({
          targetPort: request.port,
          resourceOwnerKey: owner.resourceOwnerKey,
          assertCurrent: owner.assertAllowed,
          ownerSignal: AbortSignal.any([session.signal, owner.signal]),
          target: {
            kind: "worker",
            environmentId: owner.binding.environmentId,
            ownerEpoch: owner.binding.ownerEpoch,
            remotePort: request.port,
            // Bearer connections retain resource authority, not the initiating actor or turn.
            connect: () =>
              connection.connect(() => {
                session.assertCurrent();
                owner.assertCurrent();
              }, owner.touch),
          },
          onClose: close,
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.path !== undefined ? { path: request.path } : {}),
        });
        changed(options);
        owner.assertAllowed();
        options.respond(true, opened);
      } catch (error) {
        fail(options, error);
      }
    },
  ),
  "portal.session.close": defineValidatedGatewayMethod(
    "portal.session.close",
    validateSessionPortalCloseParams,
    async (options) => {
      try {
        const owner = sessionPortalOwner(options, options.params.environmentId);
        if (
          !owner.service
            .listWorkerPortals(
              owner.binding.environmentId,
              owner.binding.ownerEpoch,
              owner.resourceOwnerKey,
            )
            .some(({ id }) => id === options.params.id)
        ) {
          throw new Error("Portal does not belong to this conversation's attached environment");
        }
        await owner.service.close(options.params.id, owner.assertAllowed);
        changed(options);
        owner.assertAllowed();
        options.respond(true, { closed: true });
      } catch (error) {
        fail(options, error);
      }
    },
  ),
};
