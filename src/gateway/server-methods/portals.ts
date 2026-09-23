import {
  ErrorCodes,
  errorShape,
  type PortalSummary,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import { sessionPortalHandlers } from "./portals.session.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

function requirePortalService(
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
  respond: RespondFn,
) {
  const service = context.portalService;
  if (!service) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "portals unavailable"));
  }
  return service;
}

function redactPortalSummary(summary: PortalSummary): PortalSummary {
  const { tokenQuery: _tokenQuery, url: _url, ...redacted } = summary;
  return redacted;
}

function attachedPortalOwner(options: GatewayRequestHandlerOptions, environmentId: string) {
  const { context } = options;
  const environments = context.workerEnvironmentService;
  if (!environments) {
    throw new Error("Conversation environments are unavailable");
  }
  const caller = resolveSessionEnvironmentCaller(options);
  const binding = environments.findSessionAttachment(caller.identity);
  if (!binding || binding.environmentId !== environmentId) {
    throw new Error("Portal environment is not attached to this conversation");
  }
  const assertCurrent = () => {
    caller.assertCurrent();
    environments.assertSessionAttachment(binding);
  };
  assertCurrent();
  return { binding, environments, assertCurrent };
}

export const portalHandlers: GatewayRequestHandlers = {
  ...sessionPortalHandlers,
  "portal.list": defineValidatedGatewayMethod(
    "portal.list",
    validatePortalListParams,
    (options) => {
      const { params, respond, context, client } = options;
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
      let portals: PortalSummary[];
      try {
        const owner = params.environmentId
          ? attachedPortalOwner(options, params.environmentId)
          : undefined;
        portals = owner
          ? service.listWorkerPortals(owner.binding.environmentId, owner.binding.ownerEpoch)
          : service.list();
      } catch (error) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
        return;
      }
      respond(
        true,
        {
          portals:
            scopes.includes(WRITE_SCOPE) || scopes.includes(ADMIN_SCOPE)
              ? portals
              : portals.map(redactPortalSummary),
        },
        undefined,
      );
    },
  ),
  "portal.open": defineValidatedGatewayMethod(
    "portal.open",
    validatePortalOpenParams,
    async (options) => {
      const { params: request, respond, context } = options;
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      try {
        const owner = request.environmentId
          ? attachedPortalOwner(options, request.environmentId)
          : undefined;
        await owner?.environments.touchSessionAttachment(owner.binding);
        owner?.assertCurrent();
        const connection = owner
          ? await owner.environments.openNodePortal({
              environmentId: owner.binding.environmentId,
              ownerEpoch: owner.binding.ownerEpoch,
              remotePort: request.port,
            })
          : undefined;
        try {
          owner?.assertCurrent();
        } catch (error) {
          await connection?.close();
          throw error;
        }
        const opened = await service.open({
          targetPort: request.port,
          ...(owner && connection
            ? {
                target: {
                  kind: "worker" as const,
                  environmentId: owner.binding.environmentId,
                  ownerEpoch: owner.binding.ownerEpoch,
                  remotePort: request.port,
                  connect: async () => {
                    owner.environments.assertSessionAttachment(owner.binding);
                    const stream = await connection.connect();
                    try {
                      await owner.environments.touchSessionAttachment(owner.binding);
                      owner.environments.assertSessionAttachment(owner.binding);
                      return stream;
                    } catch (error) {
                      stream.destroy();
                      throw error;
                    }
                  },
                },
                assertCurrent: owner.assertCurrent,
                onClose: connection.close,
              }
            : {}),
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(request.description !== undefined ? { description: request.description } : {}),
          ...(request.path !== undefined ? { path: request.path } : {}),
        });
        owner?.assertCurrent();
        context.broadcast(
          "portal.changed",
          { portals: service.list().map(redactPortalSummary) },
          { dropIfSlow: true },
        );
        respond(true, opened, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  ),
  "portal.close": defineValidatedGatewayMethod(
    "portal.close",
    validatePortalCloseParams,
    async (options) => {
      const { params, respond, context } = options;
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      try {
        const owner = params.environmentId
          ? attachedPortalOwner(options, params.environmentId)
          : undefined;
        if (
          owner &&
          !service
            .listWorkerPortals(owner.binding.environmentId, owner.binding.ownerEpoch)
            .some((portal) => portal.id === params.id)
        ) {
          throw new Error("Portal does not belong to the attached environment");
        }
        if (owner) {
          await service.close(params.id, owner.assertCurrent);
        } else {
          await service.close(params.id);
        }
        owner?.assertCurrent();
        context.broadcast(
          "portal.changed",
          { portals: service.list().map(redactPortalSummary) },
          { dropIfSlow: true },
        );
        respond(true, { closed: true }, undefined);
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  ),
};
