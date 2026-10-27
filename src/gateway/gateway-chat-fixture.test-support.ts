import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { expect } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  removeGatewayTempHome,
  createGatewayConfigPath,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type Gateway = Awaited<ReturnType<typeof startGatewayWithClient>>;

export function createChatFixture(
  name: string,
  options: {
    configure?: (
      config: OpenClawConfig,
      model: ReturnType<typeof buildMockOpenAiResponsesProvider>,
    ) => OpenClawConfig;
    respond?: (
      body: string,
      sessionId: string | undefined,
      response: ServerResponse,
    ) => Promise<string | undefined>;
    reset?: () => void;
  } = {},
) {
  const requests: string[] = [];
  const sessionIds: Array<string | undefined> = [];
  const errors: unknown[] = [];
  const provider = createServer((request, response) => {
    void (async () => {
      const body = await readRequestText(request);
      const header = request.headers.session_id;
      const sessionId = typeof header === "string" ? header : undefined;
      requests.push(body);
      sessionIds.push(sessionId);
      const text = options.respond
        ? await options.respond(body, sessionId, response)
        : "Fixture reply complete.";
      if (text !== undefined) {
        writeOpenAiResponsesText(response, {
          text,
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
      }
    })().catch((error: unknown) => {
      errors.push(error);
      response.writeHead(500).end("fixture provider failed");
    });
  });
  let home: Awaited<ReturnType<typeof setupGatewayTempHome>> | undefined;
  let gateway: Gateway | undefined;
  let startup: Pick<
    Parameters<typeof startGatewayWithClient>[0],
    "cfg" | "configPath" | "token" | "clientDisplayName"
  >;
  const launch = async () => {
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway = await startGatewayWithClient({
      ...startup,
      portClaim,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: `http://127.0.0.1:${portClaim.port}`,
    });
    await gateway.server.startupSettled;
  };
  return {
    requests,
    sessionIds,
    errors,
    get client() {
      if (!gateway) {
        throw new Error("chat fixture has not started");
      }
      return gateway.client;
    },
    async start() {
      resetGatewayTestState();
      options.reset?.();
      home = await setupGatewayTempHome({ prefix: `openclaw-${name}-` });
      const model = buildMockOpenAiResponsesProvider(
        await listenProvider(provider),
        `${name}-fixture`,
      );
      const token = randomUUID();
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: home.workspaceDir,
            skipBootstrap: true,
            model: { primary: model.modelRef },
            models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
          },
        },
        models: { mode: "replace", providers: { [model.providerId]: model.config } },
        gateway: { auth: { mode: "token", token } },
        hooks: { enabled: false },
      };
      startup = {
        cfg: options.configure?.(config, model) ?? config,
        token,
        configPath: await createGatewayConfigPath(home.tempHome),
        clientDisplayName: `${name}-test`,
      };
      await launch();
    },
    async restart() {
      if (!gateway) {
        throw new Error("chat fixture has not started");
      }
      await disconnectGatewayClient(gateway.client);
      await gateway.server.close({ reason: "prompt-prefix restart proof" });
      await launch();
    },
    async close() {
      try {
        if (gateway) {
          try {
            await disconnectGatewayClient(gateway.client);
          } finally {
            await gateway.server.close({ reason: `${name} test complete` });
          }
        }
      } finally {
        await closeProvider(provider);
        options.reset?.();
        resetGatewayTestState();
        if (home) {
          await removeGatewayTempHome(home.tempHome);
          home.envSnapshot.restore();
        }
      }
    },
  };
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
