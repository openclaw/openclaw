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
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { prepareGatewayRestartIteration } from "../cli/gateway-cli/run-loop-startup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries } from "../infra/system-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
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
  let notice = createDeferredCore<ProviderRequest>();
  let spawn: Receipt | undefined;
  let spawnRequested = false;
  const server = createServer((request, response) => {
    void (async () => {
      const body = (await json(request)) as ProviderRequest;
      requests.push(body);
      const input = JSON.stringify(body.input);
      const title = input.includes("Generate a concise session title");
      const isNotice = Boolean(
        spawn &&
        input.includes(spawn.childSessionKey) &&
        input.includes("Reconcile before acting:"),
      );
      const reconciliation = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_reconcile",
      )?.output;
      const output = body.input.find(
        (item) => item.type === "function_call_output" && item.call_id === "call_spawn",
      )?.output;
      if (output) {
        spawn = JSON.parse(output) as Receipt;
      }
      const call =
        !title && isNotice && !reconciliation
          ? {
              name: "session_status",
              id: "call_reconcile",
              args: { sessionKey: spawn?.childSessionKey, changesSince: 0 },
            }
          : !title && !isNotice && !spawnRequested
            ? {
                name: "sessions_spawn",
                id: "call_spawn",
                args: {
                  task: `Return CHILD-DONE. ${WORKER}`,
                  visible: true,
                  mode: "run",
                  expectsCompletionMessage: false,
                },
              }
            : undefined;
      if (call) {
        if (call.name === "sessions_spawn") {
          spawnRequested = true;
        } else if (!spawn) {
          throw new Error("Reconciliation preceded the real child spawn receipt");
        }
        const item = {
          type: "function_call",
          id: `fc_${call.id}`,
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.args),
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
              id: `resp_${call.id}`,
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
      } else {
        writeOpenAiResponsesText(response, {
          text: title ? "Store lifecycle proof" : isNotice ? "NO_REPLY" : "CHILD-DONE",
          messageId: `msg_${requests.length}`,
          responseId: `resp_${requests.length}`,
        });
      }
      if (isNotice && reconciliation) {
        notice.resolve(body);
      }
    })().catch((error: unknown) => {
      errors.push(error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    });
  });
  const claim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await claim.release();
    throw error;
  }
  return {
    baseUrl: `http://127.0.0.1:${claim.port}/v1`,
    requests,
    errors,
    armNoticeObservation() {
      notice = createDeferredCore<ProviderRequest>();
      return notice.promise;
    },
    get spawn() {
      return spawn;
    },
    async stop() {
      server.closeAllConnections();
      await runQaGatewayFixture(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
        () => claim.release(),
      );
    },
  };
}

describe("session notice store ownership through the Gateway", () => {
  it.for(["different store", "same-store replacement", "same-store soft restart"] as const)(
    "handles a queued child notice after %s",
    { timeout: 180_000 },
    async (transition, { signal }) => {
      resetGatewayTestState();
      const home = await setupGatewayTempHome({ prefix: "openclaw-session-notice-store-" });
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
                subagents: { allowAgents: ["*"], maxConcurrent: 2 },
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
              catalogRefresh: { enabled: false },
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
            // The provider scripts a direct spawn to isolate notification-store ownership.
            tools: { profile: "coding", toolSearch: false },
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
          const followupResult = await wait(followup.runId);
          expect(followupResult.status, JSON.stringify(followupResult)).toBe("ok");

          expect(
            peekSystemEventEntries(parentKey).some((event) =>
              event.text.includes(child.childSessionKey),
            ),
          ).toBe(true);

          if (transition === "different store") {
            const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
            await gateway.client.request("config.patch", {
              baseHash: hash,
              raw: JSON.stringify({
                session: { store: newStore },
                agents: { defaults: { model: "proof/backup" } },
              }),
            });
            expect(peekSystemEventEntries(parentKey)).toEqual([]);
            const after = await gateway.client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
              limit: 100,
            });
            expect(after.sessions.map((entry) => entry.key)).not.toContain(parentKey);
            expect(after.sessions.map((entry) => entry.key)).not.toContain(child.childSessionKey);
            expect(provider.requests.map((request) => request.model)).not.toContain("backup");
          } else {
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({
              reason: transition,
              ...(transition === "same-store soft restart" ? { restartExpectedMs: 0 } : {}),
            });
            gateway = undefined;
            const replacementRequestOffset = provider.requests.length;
            const replacementNotice = provider.armNoticeObservation();
            await prepareGatewayRestartIteration(
              await import("../cli/gateway-cli/lifecycle.runtime.js"),
              {
                warn: (message) => {
                  throw new Error(message);
                },
              },
              () => !signal.aborted,
            );
            gateway = await start();
            await gateway.server.startupSettled;
            // Await the actual delayed notification; replacement must not need another wake.
            const notice = await withinTest(replacementNotice, signal);
            expect(provider.requests.indexOf(notice)).toBeGreaterThanOrEqual(
              replacementRequestOffset,
            );
            expect(notice.model).toBe("primary");
            expect(JSON.stringify(notice.input)).toContain(child.childSessionKey);
            expect(JSON.stringify(notice.input)).toContain(WORKER);
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
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "session notice store proof complete" }),
        () => provider?.stop(),
        () => resetSubagentRegistryForTests({ persist: false }),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        resetGatewayTestState,
      );
    },
  );
});
