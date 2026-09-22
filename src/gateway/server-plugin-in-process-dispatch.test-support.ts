import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { createInternalAgentTurnFacade } from "./agent-turn/internal-facade.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

export function createContext(): GatewayRequestContext {
  const context = {
    trackExecution: trackAsyncWork,
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn() },
  } as unknown as GatewayRequestContext;
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

export function createOperatorClient(params: {
  caps?: string[];
  profileId: string;
  scopes: string[];
}): NonNullable<GatewayRequestOptions["client"]> {
  return {
    connId: `conn-${params.profileId}`,
    authenticatedUserId: `${params.profileId}@example.com`,
    authenticatedUserProfile: {
      profileId: params.profileId,
      displayName: params.profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: {
      ...(params.caps ? { caps: params.caps } : {}),
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      role: "operator",
      scopes: params.scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.TEST,
        version: "1",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.TEST,
      },
    },
  };
}
