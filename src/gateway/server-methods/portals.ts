import {
  ErrorCodes,
  errorShape,
  type PortalSummary,
  validatePortalCloseParams,
  validatePortalListParams,
  validatePortalOpenParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { ADMIN_SCOPE, WRITE_SCOPE } from "../operator-scopes.js";
import {
  createPortalOperations,
  redactPortalSummary,
  type GatewayPortalService,
} from "../portals/portal-service.js";
import { resolveSessionEnvironmentCaller } from "./environments.session.js";
import { broadcastPortalChange, sessionPortalHandlers } from "./portals.session.js";
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

async function portalOperations(
  options: GatewayRequestHandlerOptions,
  service: GatewayPortalService,
  environmentId?: string,
) {
  if (!environmentId) {
    return { operations: createPortalOperations(service), release() {} };
  }
  const { context } = options;
  const environments = context.workerEnvironmentService;
  if (!environments) {
    throw new Error("Conversation environments are unavailable");
  }
  const caller = await resolveSessionEnvironmentCaller(options);
  try {
    const binding = environments.findSessionAttachment(caller.identity);
    if (!binding || binding.environmentId !== environmentId) {
      throw new Error("Portal environment is not attached to this conversation");
    }
    const assertCurrent = () => {
      caller.assertCurrent();
      environments.assertSessionAttachment(binding);
    };
    assertCurrent();
    return {
      release: caller.release,
      operations: createPortalOperations(service, {
        ...binding,
        assertCurrent,
        ownershipError: "Portal does not belong to the attached environment",
        async prepareTarget(remotePort) {
          await environments.touchSessionAttachment(binding);
          assertCurrent();
          const connection = await environments.openNodePortal({
            environmentId: binding.environmentId,
            ownerEpoch: binding.ownerEpoch,
            remotePort,
          });
          return {
            ...connection,
            connect: () =>
              connection.connect(
                () => environments.assertSessionAttachment(binding),
                () => environments.touchSessionAttachment(binding),
              ),
          };
        },
      }),
    };
  } catch (error) {
    caller.release();
    throw error;
  }
}

async function mutatePortal(
  options: GatewayRequestHandlerOptions,
  environmentId: string | undefined,
  mutate: (portals: ReturnType<typeof createPortalOperations>) => Promise<unknown>,
) {
  const service = requirePortalService(options.context, options.respond);
  if (!service) {
    return;
  }
  let scope: Awaited<ReturnType<typeof portalOperations>> | undefined;
  try {
    scope = await portalOperations(options, service, environmentId);
    const result = await mutate(scope.operations);
    broadcastPortalChange(options.context, service);
    options.respond(true, result, undefined);
  } catch (error) {
    options.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, error instanceof Error ? error.message : String(error)),
    );
  } finally {
    scope?.release();
  }
}

export const portalHandlers: GatewayRequestHandlers = {
  ...sessionPortalHandlers,
  "portal.list": defineValidatedGatewayMethod(
    "portal.list",
    validatePortalListParams,
    async (options) => {
      const { params, respond, context, client } = options;
      const service = requirePortalService(context, respond);
      if (!service) {
        return;
      }
      const scopes = client?.connect.scopes ?? [];
      let portals: PortalSummary[];
      try {
        const scope = await portalOperations(options, service, params.environmentId);
        try {
          portals = scope.operations.list().portals;
        } finally {
          scope.release();
        }
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
  "portal.open": defineValidatedGatewayMethod("portal.open", validatePortalOpenParams, (options) =>
    mutatePortal(options, options.params.environmentId, (portals) => portals.open(options.params)),
  ),
  "portal.close": defineValidatedGatewayMethod(
    "portal.close",
    validatePortalCloseParams,
    (options) =>
      mutatePortal(options, options.params.environmentId, (portals) =>
        portals.close(options.params.id),
      ),
  ),
};
