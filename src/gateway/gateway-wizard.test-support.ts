import {
  nextGatewayId,
  removeGatewayTempHome,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer, type GatewayServerOptions } from "./server.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

export async function startWizardGateway(
  runners: Pick<GatewayServerOptions, "wizardRunner" | "channelWizardRunner">,
  releaseRunner = () => {},
) {
  const { envSnapshot, tempHome } = await setupGatewayTempHome({
    prefix: "openclaw-wizard-home-",
    minimalGateway: true,
  });
  const token = nextGatewayId("wizard");
  const clients: Array<Awaited<ReturnType<typeof connectGatewayClient>>> = [];
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  const cleanup = async () => {
    releaseRunner();
    try {
      await Promise.all(clients.map(disconnectGatewayClient));
      await server?.close({ reason: "wizard E2E complete" });
    } finally {
      releaseRunner();
      try {
        await removeGatewayTempHome(tempHome);
      } finally {
        envSnapshot.restore();
      }
    }
  };
  try {
    const claim = await acquireGatewayE2ePortBlock();
    server = await startClaimedGateway(claim, () =>
      startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        ...runners,
      }),
    );
    return {
      server,
      async connect(clientDisplayName?: string) {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          clientDisplayName,
        });
        clients.push(client);
        return client;
      },
      [Symbol.asyncDispose]: cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
