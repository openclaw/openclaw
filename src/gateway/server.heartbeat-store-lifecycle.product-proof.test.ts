// Exercise producer target ownership through real Gateway reload/replacement and provider HTTP.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { prepareGatewayRestartIteration } from "../cli/gateway-cli/run-loop-startup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

const NOTICE = "RECOVERED-SESSION-NOTICE";
type ProviderRequest = { model: string; input: unknown[] };

async function startProvider() {
  const requests: ProviderRequest[] = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const body = (await json(request)) as ProviderRequest;
      const title = JSON.stringify(body.input).includes("Generate a concise session title");
      if (!title) {
        requests.push(body);
      }
      writeOpenAiResponsesText(response, {
        text: title ? "Store lifecycle proof" : NOTICE,
        messageId: `msg_${requests.length}`,
        responseId: `resp_${requests.length}`,
      });
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    errors,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("session event target ownership through the Gateway", () => {
  it.each(["different store", "same-store replacement"] as const)(
    "rejects a retired producer after %s",
    async (transition) => {
      resetGatewayTestState();
      const home = await setupGatewayTempHome({ prefix: "openclaw-event-store-" });
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      await runQaGatewayFixture(
        async () => {
          provider = await startProvider();
          const token = randomUUID();
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
          const oldStore = path.join(home.tempHome, "old-store", "sessions.json");
          const newStore = path.join(home.tempHome, "new-store", "sessions.json");
          const cfg: OpenClawConfig = {
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: home.workspaceDir,
                skipBootstrap: true,
                model: "proof/primary",
                models: Object.fromEntries(
                  ["primary", "backup"].map((model) => [
                    `proof/${model}`,
                    {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  ]),
                ),
              },
            },
            models: {
              mode: "replace",
              providers: {
                proof: {
                  baseUrl: provider.baseUrl,
                  apiKey: "synthetic-key",
                  api: "openai-responses",
                  request: { allowPrivateNetwork: true },
                  models: ["primary", "backup"].map((id) => ({
                    id,
                    name: id,
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  })),
                },
              },
            },
            session: { store: oldStore },
            tools: { profile: "minimal" },
            plugins: { slots: { memory: "none" } },
            gateway: { auth: { mode: "token", token } },
            hooks: { enabled: false },
          };
          const configPath = await createGatewayConfigPath(home.tempHome);
          const start = () =>
            startGatewayWithClient({
              cfg,
              configPath,
              token,
              clientName: GATEWAY_CLIENT_NAMES.CLI,
              mode: GATEWAY_CLIENT_MODES.CLI,
              scopes: ["operator.admin"],
            });
          gateway = await start();
          await gateway.server.startupSettled;
          const sessionKey = `agent:main:store-proof-${randomUUID()}`;
          await gateway.client.request("sessions.create", { key: sessionKey });
          const retiredTarget = await captureSessionEventTargetForHost("main", sessionKey);
          expect(retiredTarget.sessionId).not.toBe("");

          if (transition === "different store") {
            const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
            await gateway.client.request("config.patch", {
              baseHash: hash,
              raw: JSON.stringify({
                session: { store: newStore },
                agents: { defaults: { model: "proof/backup" } },
              }),
            });
            expect(() =>
              enqueueSessionEventForHost(NOTICE, {
                agentId: "main",
                sessionKey,
                source: "session",
                expectedTarget: retiredTarget,
              }),
            ).toThrow("destination was reset or replaced");
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.map((entry) => entry.key)).not.toContain(sessionKey);
            expect(provider.requests).toEqual([]);
          } else {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "same-store replacement" });
            gateway = undefined;
            await prepareGatewayRestartIteration(
              await import("../cli/gateway-cli/lifecycle.runtime.js"),
              {
                warn: (message) => {
                  throw new Error(message);
                },
              },
            );
            gateway = await start();
            await gateway.server.startupSettled;
            const currentTarget = await captureSessionEventTargetForHost("main", sessionKey);
            expect(currentTarget.storePath).toBe(retiredTarget.storePath);
            expect(currentTarget.sessionId).toBe(retiredTarget.sessionId);
            expect(currentTarget.generation).not.toBe(retiredTarget.generation);
            expect(() =>
              enqueueSessionEventForHost(NOTICE, {
                agentId: "main",
                sessionKey,
                source: "session",
                expectedTarget: retiredTarget,
              }),
            ).toThrow("stale gateway lifecycle");
            expect(provider.requests).toEqual([]);
            // Recovery captures new runtime authority for the retained physical session.
            const receipt = enqueueSessionEventForHost(NOTICE, {
              agentId: "main",
              sessionKey,
              source: "session",
              expectedTarget: currentTarget,
            });
            expect(await receipt.settled).toMatchObject({
              status: "completed",
              executionStarted: true,
            });
            expect(provider.requests).toHaveLength(1);
            expect(provider.requests[0]?.model).toBe("primary");
            expect(JSON.stringify(provider.requests[0]?.input)).toContain(NOTICE);
            const history = await gateway.client.request<{
              sessionId: string;
              messages: Array<{ role?: string; content?: unknown }>;
            }>("chat.history", { sessionKey });
            expect(history.sessionId).toBe(retiredTarget.sessionId);
            expect(
              history.messages.filter(
                (message) =>
                  message.role === "assistant" && JSON.stringify(message.content).includes(NOTICE),
              ),
            ).toHaveLength(1);
          }
          expect(provider.errors).toEqual([]);
        },
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "session event store proof complete" }),
        () => provider?.stop(),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        resetGatewayTestState,
      );
    },
    180_000,
  );
});
