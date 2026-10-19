import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { connectGatewayClient } from "../../src/gateway/test-helpers.e2e.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";

export const commandSecretFixture = {
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
  resolveCommandSecretRefsViaGateway: async ({ config }: { config: OpenClawConfig }) => ({
    resolvedConfig: config,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  }),
};

export async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function respondJson(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function listenLoopback(server: Server | HttpsServer, protocol = "http") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture did not bind a loopback TCP listener");
  }
  return `${protocol}://127.0.0.1:${address.port}`;
}

export async function closeHttpServer(server: Server | HttpsServer) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function connectProofClient(
  instance: Pick<OpenClawTestInstance, "url" | "gatewayToken">,
  options: Omit<Parameters<typeof connectGatewayClient>[0], "url" | "token"> = {},
) {
  const { connectGatewayClient } = await import("../../src/gateway/test-helpers.e2e.js");
  return connectGatewayClient({ url: instance.url, token: instance.gatewayToken, ...options });
}
