/**
 * OpenAI-compatible HTTP gateway startup helper for tests.
 */
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { reserveGatewayTestListener } from "./test-helpers.listener.js";

type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/** Starts a local gateway with only the OpenAI-compatible HTTP surface configured. */
export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: (
    port: number,
    options: GatewayServerOptions,
  ) => ReturnType<StartGatewayServer>;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  const reservation = await reserveGatewayTestListener();
  try {
    const server = await reservation.start(() =>
      options.startGatewayServer(reservation.port, {
        host: "127.0.0.1",
        auth: options.auth,
        controlUiEnabled: false,
        openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
      }),
    );
    return {
      ...server,
      port: reservation.port,
      close: async (...args: Parameters<typeof server.close>) => {
        await server.close(...args);
        await reservation.closeUnadopted();
      },
    };
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, reservation.closeUnadopted);
  }
}
