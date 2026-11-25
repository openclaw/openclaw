import { listenLoopback } from "../../../test/helpers/gateway-integration-fixtures.js";
import { createGatewayHttpServer } from "../server-http.js";
import { createNodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";

export function transferOwner(sessionId: string, ownerEpoch = 1, expiresAtMs?: number) {
  return {
    credential: { ownerEpoch, sessionId, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) },
    environment: {
      ownerEpoch,
      attachedSessionIds: [sessionId],
      destroyRequestedAtMs: null,
      state: "attached",
    },
  };
}

export async function startNodeWorkspaceTransferTestServer(service: NodeWorkspaceTransferService) {
  const server = createGatewayHttpServer({
    clients: new Set(),
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "none", allowTailscale: false },
    getRuntimeConfig: () => ({}),
    handleNodeWorkspaceTransferRequest: createNodeWorkspaceTransferHttpCallback(service),
  });
  const gatewayUrl = await listenLoopback(server, "ws");
  return {
    gatewayUrl,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
