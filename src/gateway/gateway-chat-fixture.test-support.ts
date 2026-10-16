import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { expect } from "vitest";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { closeProvider } from "./gateway-provider-fixture.test-support.js";
import {
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

type Gateway = Awaited<ReturnType<typeof startGatewayWithClient>>;

export async function startControlUiGateway(
  options: Pick<
    Parameters<typeof startGatewayWithClient>[0],
    "cfg" | "configPath" | "token" | "clientDisplayName"
  >,
) {
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  return startGatewayWithClient({
    ...options,
    portClaim,
    clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    origin: `http://127.0.0.1:${portClaim.port}`,
  });
}

export async function closeChatFixture(
  gateway: Gateway | undefined,
  provider: Server,
  home: Awaited<ReturnType<typeof setupGatewayTempHome>> | undefined,
  reason: string,
  reset?: () => void,
) {
  try {
    if (gateway) {
      try {
        await disconnectGatewayClient(gateway.client);
      } finally {
        await gateway.server.close({ reason });
      }
    }
  } finally {
    await closeProvider(provider);
    reset?.();
    resetGatewayTestState();
    if (home) {
      await removeGatewayTempHome(home.tempHome);
      home.envSnapshot.restore();
    }
  }
}

export async function sendChatAndWait(
  client: Gateway["client"],
  sessionKey: string,
  message: string,
  timeoutMs = 30_000,
): Promise<string> {
  const accepted = await client.request<{ runId: string; status: string }>("chat.send", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  expect(accepted.status).toBe("started");
  const completed = await client.request<{ status: string }>(
    "agent.wait",
    { runId: accepted.runId, timeoutMs },
    { timeoutMs: timeoutMs + 5_000 },
  );
  expect(completed.status).toBe("ok");
  return accepted.runId;
}
