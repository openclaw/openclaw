// Exercise notification ownership through real Gateway reload/replacement and provider HTTP.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { requestHeartbeatAndWait, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import { createDeferredCore } from "../shared/deferred.js";
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

const WORKER = "OLD-STORE-CHILD";
type Receipt = { status: string; runId: string; childSessionKey: string };
type ProviderRequest = {
  model: string;
  input: Array<{ type?: string; role?: string; call_id?: string; output?: string }>;
};

async function startProvider() {
  const requests: ProviderRequest[] = [];
  const errors: unknown[] = [];
  const heartbeat = createDeferredCore<ProviderRequest>();
  let spawn: Receipt | undefined;
  let spawnRequested = false;
  const server = createServer((request, response) => {
    void (async () => {
      const body = (await json(request)) as ProviderRequest;
      requests.push(body);
      const title = JSON.stringify(body.input).includes("Generate a concise session title");
      const isHeartbeat = JSON.stringify(body.input).includes(
        "Follow the heartbeat monitor scratch context",
      );
      const output = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_spawn",
      )?.output;
      if (output) {
        spawn = JSON.parse(output) as Receipt;
      }
      if (!title && !spawnRequested) {
        spawnRequested = true;
        const item = {
          type: "function_call",
          id: "fc_spawn",
          call_id: "call_spawn",
          name: "sessions_spawn",
          arguments: JSON.stringify({
            task: `Return CHILD-DONE. ${WORKER}`,
            visible: true,
            mode: "run",
            expectsCompletionMessage: false,
          }),
        };
        writeOpenAiResponsesSse(response, [
          { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
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
      } else {
        writeOpenAiResponsesText(response, {
          text: title ? "Store lifecycle proof" : isHeartbeat ? "NO_REPLY" : "CHILD-DONE",
          messageId: `msg_${requests.length}`,
          responseId: `resp_${requests.length}`,
        });
      }
      if (isHeartbeat) {
        heartbeat.resolve(body);
      }
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
    heartbeat: heartbeat.promise,
    get spawn() {
      return spawn;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("heartbeat notification store ownership through the Gateway", () => {
  it.each(["different store", "same-store replacement"] as const)(
    "handles a queued child notice after %s",
    async (transition) => {
      resetGatewayTestState();
      resetHeartbeatEventsForTest();
      const home = await setupGatewayTempHome({ prefix: "openclaw-heartbeat-store-" });
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
                heartbeat: { every: "30m" },
                subagents: { allowAgents: ["*"], maxConcurrent: 2 },
                models: Object.fromEntries(
                  ["primary", "backup"].map((model) => [
                    `proof/${model}`,
                    { params: { transport: "sse", openaiWsWarmup: false } },
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
            tools: { profile: "coding" },
            gateway: { auth: { mode: "token", token } },
            hooks: { enabled: false },
          };
          const start = () =>
            startGatewayWithClient({
              cfg,
              configPath,
              token,
              clientName: GATEWAY_CLIENT_NAMES.CLI,
              mode: GATEWAY_CLIENT_MODES.CLI,
              scopes: ["operator.admin"],
            });
          const configPath = await createGatewayConfigPath(home.tempHome);
          gateway = await start();
          await gateway.server.startupSettled;
          const parentKey = `agent:main:store-proof-${randomUUID()}`;
          const wait = (runId: string) =>
            gateway!.client.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: 120_000 },
              { timeoutMs: 125_000 },
            );
          const accepted = await gateway.client.request<{ runId: string }>(
            "chat.send",
            {
              sessionKey: parentKey,
              message: "Spawn one worker now.",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: false },
          );
          expect((await wait(accepted.runId)).status).toBe("ok");
          expect(provider.spawn?.status).toBe("accepted");
          const child = provider.spawn;
          if (!child) {
            throw new Error("Parent did not receive sessions_spawn receipt");
          }
          expect((await wait(child.runId)).status).toBe("ok");
          const before = await gateway.client.request<SessionsListResult>("sessions.list", {
            agentId: "main",
            limit: 100,
          });
          const parentSessionId = before.sessions.find(
            (entry) => entry.key === parentKey,
          )?.sessionId;
          expect(parentSessionId).toBeTypeOf("string");
          const followup = await gateway.client.request<{ runId: string }>(
            "agent",
            {
              sessionKey: child.childSessionKey,
              message: `Human followup ${WORKER}`,
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { expectFinal: false },
          );
          expect((await wait(followup.runId)).status).toBe("ok");

          if (transition === "different store") {
            const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
            await gateway.client.request("config.patch", {
              baseHash: hash,
              raw: JSON.stringify({
                session: { store: newStore },
                agents: { defaults: { model: "proof/backup" } },
              }),
            });
            expect(await gateway.client.request("last-heartbeat", {})).toMatchObject({
              status: "skipped",
              reason: "store-replaced",
            });
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.map((entry) => entry.key)).not.toContain(parentKey);
            expect(after.sessions.map((entry) => entry.key)).not.toContain(child.childSessionKey);
            expect(provider.requests.map((request) => request.model)).not.toContain("backup");
          } else {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "same-store replacement" });
            gateway = undefined;
            const replacementRequestOffset = provider.requests.length;
            gateway = await start();
            await gateway.server.startupSettled;
            // Await the actual delayed notification; replacement must not need another wake.
            const heartbeat = await provider.heartbeat;
            expect(provider.requests.indexOf(heartbeat)).toBeGreaterThanOrEqual(
              replacementRequestOffset,
            );
            expect(heartbeat.model).toBe("primary");
            expect(JSON.stringify(heartbeat.input)).toContain(child.childSessionKey);
            expect(JSON.stringify(heartbeat.input)).toContain(WORKER);
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.find((entry) => entry.key === parentKey)?.sessionId).toBe(
              parentSessionId,
            );
          }
          expect(provider.errors).toEqual([]);
        },
        async () => {
          if (!gateway) {
            return;
          }
          setHeartbeatsEnabled(false);
          await requestHeartbeatAndWait({
            source: "manual",
            intent: "immediate",
            reason: "wake",
            coalesceMs: 0,
          });
        },
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "heartbeat store proof complete" }),
        () => provider?.stop(),
        () => resetSubagentRegistryForTests({ persist: false }),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        () => setHeartbeatsEnabled(true),
        resetHeartbeatEventsForTest,
        resetGatewayTestState,
      );
    },
    180_000,
  );
});
