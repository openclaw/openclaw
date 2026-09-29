// Exercise a write-only operator's visible sessions_spawn through a real Gateway and client.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { json } from "node:stream/consumers";
import { afterEach, describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
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
import {
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

type ProviderRequest = {
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
};

async function startSpawningProvider() {
  let spawnOutput: string | undefined;
  let spawnRequested = false;
  const server = createServer((request, response) => {
    void (async () => {
      const body = (await json(request)) as ProviderRequest;
      const title = JSON.stringify(body.input).includes("Generate a concise session title");
      spawnOutput ??= body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_spawn",
      )?.output;
      if (title || spawnRequested) {
        writeOpenAiResponsesText(response, {
          text: title ? "Start failure proof" : "Parent complete",
          messageId: `msg_${randomUUID()}`,
          responseId: `resp_${randomUUID()}`,
        });
        return;
      }
      spawnRequested = true;
      const item = {
        type: "function_call",
        id: "fc_call_spawn",
        call_id: "call_spawn",
        name: "sessions_spawn",
        arguments: JSON.stringify({ task: "Inspect the workspace.", visible: true }),
      };
      writeOpenAiResponsesSse(response, [
        { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
        { type: "response.output_item.done", output_index: 0, item },
        {
          type: "response.completed",
          response: {
            id: "resp_spawn",
            status: "completed",
            output: [item],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]);
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get spawnOutput() {
      return spawnOutput;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

afterEach(() => resetSubagentRegistryForTests({ persist: false }));

describe("visible sessions_spawn start failure through the Gateway", () => {
  it("returns the start error to a write-only operator and leaves no child", async () => {
    resetGatewayTestState();
    const home = await setupGatewayTempHome({ prefix: "openclaw-spawn-start-failure-" });
    let provider: Awaited<ReturnType<typeof startSpawningProvider>> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    await runQaGatewayFixture(
      async () => {
        provider = await startSpawningProvider();
        const token = randomUUID();
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: home.workspaceDir,
              skipBootstrap: true,
              heartbeat: { every: "0m" },
              model: { primary: "proof/primary" },
              models: { "proof/primary": { params: { transport: "sse", openaiWsWarmup: false } } },
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
                models: [
                  {
                    id: "primary",
                    name: "primary",
                    api: "openai-responses",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 4096,
                  },
                ],
              },
            },
          },
          session: {
            sendPolicy: {
              default: "allow",
              rules: [{ action: "deny", match: { keyPrefix: "agent:main:dashboard:" } }],
            },
          },
          tools: { profile: "coding", toolSearch: false },
          gateway: { auth: { mode: "token", token } },
          hooks: { enabled: false },
        };
        const port = await getGatewayE2ePortBlock();
        gateway = await startGatewayWithClient({
          cfg,
          port,
          clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          origin: `http://127.0.0.1:${port}`,
          configPath: await createGatewayConfigPath(home.tempHome),
          token,
          scopes: ["operator.approvals", "operator.questions", "operator.read", "operator.write"],
        });
        await gateway.server.startupSettled;
        const { client } = gateway;
        const parentKey = `agent:main:proof-${randomUUID()}`;
        const accepted = await client.request<{ runId: string; status: string }>(
          "chat.send",
          {
            sessionKey: parentKey,
            message: "Spawn one visible worker now.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: false },
        );
        expect(accepted.status).toBe("started");
        await client.request(
          "agent.wait",
          { runId: accepted.runId, timeoutMs: 120_000 },
          { timeoutMs: 125_000 },
        );
        const { sessions } = await client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
          limit: 100,
        });
        const dashboardChildren = sessions
          .map(({ key }) => key)
          .filter((key) => key.startsWith("agent:main:dashboard:"));
        console.info(
          JSON.stringify({ spawnToolOutput: provider.spawnOutput, dashboardChildren }, null, 2),
        );

        expect(provider.spawnOutput).toContain("send blocked by session policy");
        expect(dashboardChildren).toEqual([]);
      },
      () => gateway && disconnectGatewayClient(gateway.client),
      () => gateway?.server.close({ reason: "spawn start failure proof complete" }),
      () => provider?.stop(),
      () => removeGatewayTempHome(home.tempHome),
      () => home.envSnapshot.restore(),
      resetGatewayTestState,
    );
  }, 300_000);
});
