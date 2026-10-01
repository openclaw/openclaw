/**
 * OpenAI-compatible HTTP gateway startup helper for tests.
 */
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { TestPortClaim } from "../test-utils/port-claims.js";
import { reserveGatewayTestListener, startClaimedGateway } from "./test-helpers.listener.js";

type StartGatewayServer = typeof import("./server.js").startGatewayServer;
type GatewayServerOptions = NonNullable<Parameters<StartGatewayServer>[1]>;

/** Starts a local gateway with only the OpenAI-compatible HTTP surface configured. */
export async function startOpenAiCompatGatewayServer(options: {
  startGatewayServer: StartGatewayServer;
  port: TestPortClaim;
  auth: GatewayServerOptions["auth"];
  openAiChatCompletionsEnabled?: boolean;
}) {
  const reservation = await reserveGatewayTestListener(options.port);
  return await runQaGatewayFixture(
    () =>
      reservation.start(() =>
        startClaimedGateway({ port: reservation.port, release: reservation.closeUnadopted }, () =>
          options.startGatewayServer(reservation.port, {
            host: "127.0.0.1",
            auth: options.auth,
            controlUiEnabled: false,
            openAiChatCompletionsEnabled: options.openAiChatCompletionsEnabled ?? false,
          }),
        ),
      ),
    reservation.closeUnadopted,
  );
}
