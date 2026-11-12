import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { connectGatewayClient as connect } from "../../src/gateway/test-helpers.e2e.js";
import type { OpenClawTestInstance } from "./openclaw-test-instance.js";

export async function readRequestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
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

export async function connectProofClient(
  instance: Pick<OpenClawTestInstance, "url" | "gatewayToken">,
  options: Omit<Parameters<typeof connect>[0], "url" | "token"> = {},
) {
  const { connectGatewayClient } = await import("../../src/gateway/test-helpers.e2e.js");
  return connectGatewayClient({ url: instance.url, token: instance.gatewayToken, ...options });
}
