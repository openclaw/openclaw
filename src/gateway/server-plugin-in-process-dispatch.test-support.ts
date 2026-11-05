import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { createMockSubsystemLogger } from "../../test/helpers/mock-subsystem-logger.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import type {
  GatewayMethodDescriptorInput,
  GatewayMethodHandler,
  GatewayMethodScope,
} from "./methods/descriptor.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { resolveSessionRequestTargets } from "./session-request-targets.js";

export function createContext(
  methods: Array<
    [name: string, scope: GatewayMethodScope, area: string, handler: GatewayMethodHandler]
  > = [],
  getRuntimeConfig: GatewayRequestContext["getRuntimeConfig"] = () => ({}),
): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig,
    logGateway: createMockSubsystemLogger("gateway"),
  } as unknown as GatewayRequestContext;
  if (methods.length) {
    const registry = createGatewayMethodRegistry(
      methods.map(([name, scope, area, handler]): GatewayMethodDescriptorInput => ({
        name,
        scope,
        owner: { kind: "core", area },
        handler,
      })),
    );
    context.getGatewayMethodRegistry = () => registry;
  }
  context.resolveSessionRequestTargets = (request) =>
    resolveSessionRequestTargets({ ...request, context });
  context.createAgentTurnFacade = (principal) =>
    createInternalAgentTurnFacade({
      ...principal,
      getContext: () => context,
      ...(context.getGatewayMethodRegistry
        ? { getMethodRegistry: context.getGatewayMethodRegistry }
        : {}),
    });
  return context;
}

export function createOperatorClient(
  params: { caps?: string[]; scopes: string[] } & ({ profileId: string } | { profileName: string }),
): NonNullable<GatewayRequestOptions["client"]> {
  const profileId =
    "profileId" in params
      ? params.profileId
      : ensureProfileForEmail(`${params.profileName}@example.test`).id;
  return {
    connId: `conn-${profileId}`,
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: gatewayProfile(profileId, profileId),
    connect: {
      ...(params.caps ? { caps: params.caps } : {}),
      ...gatewayConnect(
        params.scopes,
        { id: GATEWAY_CLIENT_IDS.TEST, version: "1", mode: GATEWAY_CLIENT_MODES.TEST },
        PROTOCOL_VERSION,
      ),
    },
  };
}
