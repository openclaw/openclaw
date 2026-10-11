import { vi } from "vitest";
import {
  initializeSessionReadContext,
  identifiedClient as preparedClient,
} from "./sessions-read-cache.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function soloClient(): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write"],
    },
  };
}

export function identifiedClient(
  profileId: string,
  displayName: string | null = null,
): GatewayClient {
  const client = preparedClient(profileId);
  client.authenticatedUserId = `${profileId}@example.com`;
  client.authenticatedUserProfile!.displayName = displayName;
  return client;
}

export function sessionSharingTestContext(
  broadcast: ReturnType<typeof vi.fn>,
  runtimeConfig: ReturnType<GatewayRequestContext["getRuntimeConfig"]> = {},
): GatewayRequestContext {
  return {
    getRuntimeConfig: () => runtimeConfig,
    broadcast,
    broadcastToConnIds: vi.fn(),
    getSessionEventSubscriberConnIds: () => new Set(),
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
}

export async function callSessionSharingHandler(
  method:
    | "session.visibility.set"
    | "session.members.list"
    | "session.members.listEvidence"
    | "session.members.add"
    | "session.members.remove",
  params: Record<string, unknown>,
  requestContext: GatewayRequestContext,
  requestClient: GatewayClient = soloClient(),
) {
  const responses: Parameters<RespondFn>[] = [];
  await initializeSessionReadContext(requestContext);
  await sessionSharingHandlers[method]?.({
    params,
    client: requestClient,
    context: requestContext,
    respond: (...response: Parameters<RespondFn>) => responses.push(response),
  } as never);
  return responses;
}
