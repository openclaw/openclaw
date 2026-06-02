type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/**
 * Start the shared OpenAI-compatible test server with the Control UI disabled,
 * keeping models, embeddings, and chat route tests on the same auth defaults.
 */
export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: StartGatewayServer;
  port: number;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  return await options.startGatewayServer(options.port, {
    host: "127.0.0.1",
    auth: options.auth,
    controlUiEnabled: false,
    openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
  });
}
