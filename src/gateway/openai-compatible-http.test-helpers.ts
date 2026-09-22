/**
 * OpenAI-compatible HTTP gateway startup helper for tests.
 */
import type { TestPortClaim } from "../test-utils/port-claims.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/** Starts a local gateway with only the OpenAI-compatible HTTP surface configured. */
export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: StartGatewayServer;
  port: TestPortClaim;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  return await startClaimedGateway(options.port, () =>
    options.startGatewayServer(options.port.port, {
      host: "127.0.0.1",
      auth: options.auth,
      controlUiEnabled: false,
      openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
    }),
  );
}
