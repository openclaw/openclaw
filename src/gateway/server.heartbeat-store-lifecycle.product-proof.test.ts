// Exercise notification ownership through real Gateway reload/replacement and provider HTTP.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listenLoopback,
  closeHttpServer,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { resetSubagentRegistryForTests } from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { isSystemEventTurnOwned, peekSystemEventEntries } from "../infra/system-events.js";
import * as stateEventSweep from "../sessions/session-state-events.sweep.js";
import { decodeSessionStateNoticeContextKey } from "../sessions/session-state-notices.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { writeToolCallResponse } from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { productProvider } from "./server.chat-product.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

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
  const server = productProvider(errors, (raw, response) => {
    const body = JSON.parse(raw) as ProviderRequest;
    requests.push(body);
    const input = JSON.stringify(body.input);
    const title = input.includes("Generate a concise session title");
    const isNotice = Boolean(
      spawn && input.includes(spawn.childSessionKey) && input.includes("Reconcile before acting:"),
    );
    const output = body.input.find(
      (item) => item.type === "function_call_output" && item.call_id === "call_spawn",
    )?.output;
    if (output) {
      spawn = JSON.parse(output) as Receipt;
    }
    if (!title && !isNotice && !spawnRequested) {
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
      writeToolCallResponse(response, item, "resp_spawn", 1, 1);
    } else {
      writeOpenAiResponsesText(response, {
        text: title ? "Store lifecycle proof" : isNotice ? "NOTICE-RECEIVED" : "CHILD-DONE",
        messageId: `msg_${requests.length}`,
        responseId: `resp_${requests.length}`,
      });
    }
    if (isNotice) {
      notice.resolve(body);
    }
  });
  const origin = await listenLoopback(server);
  return {
    baseUrl: `${origin}/v1`,
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
      await closeHttpServer(server);
    },
  };
}

describe("session notification store ownership through the Gateway", () => {
  it.for(["different store", "same-store replacement"] as const)(
    "handles a queued child notice after %s",
    { timeout: 180_000 },
    async (transition, { signal }) => {
      resetGatewayTestState();
      resetHeartbeatEventsForTest();
      const home = await setupGatewayTempHome({ prefix: "openclaw-heartbeat-store-" });
      let provider: Awaited<ReturnType<typeof startProvider>> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let sweepSettled = createDeferredCore();
      const originalSweep = stateEventSweep.sweepSessionStateWatchNotices;
      const sweepSpy = vi
        .spyOn(stateEventSweep, "sweepSessionStateWatchNotices")
        .mockImplementation(async (options) => {
          const observedSweep = sweepSettled;
          await originalSweep(options);
          observedSweep.resolve();
        });
      await runQaGatewayFixture(
        async () => {
          provider = await startProvider();
          const token = randomUUID();
          setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
          const oldStore = path.join(home.tempHome, "old-store", "sessions.json");
          const newStore = path.join(home.tempHome, "new-store", "sessions.json");
          const { config: providerConfig } = buildMockOpenAiResponsesProvider(provider.baseUrl);
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
                    { params: { transport: "sse", openaiWsWarmup: false } },
                  ]),
                ),
              },
            },
            models: {
              mode: "replace",
              providers: {
                proof: {
                  ...providerConfig,
                  apiKey: "synthetic-key",
                  request: { allowPrivateNetwork: true },
                  models: ["primary", "backup"].map(
                    (id) =>
                      buildMockOpenAiResponsesProvider(provider!.baseUrl, id).config.models[0],
                  ),
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
          // Startup observers settle separately from startupSettled.
          await withinTest(sweepSettled.promise, signal);
          const parentKey = `agent:main:store-proof-${randomUUID()}`;
          const wait = (runId: string) =>
            gateway!.client.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: 120_000 },
              { timeoutMs: 125_000 },
            );
          const sendAndWait = async (
            method: "agent" | "chat.send",
            sessionKey: string,
            message: string,
          ) => {
            const { runId } = await gateway!.client.request<{ runId: string }>(
              method,
              {
                sessionKey,
                message,
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { expectFinal: false },
            );
            const result = await wait(runId);
            expect(result.status, JSON.stringify(result)).toBe("ok");
          };
          const sessions = async () =>
            (
              await gateway!.client.request<SessionsListResult>("sessions.list", {
                agentId: "main",
                limit: 100,
              })
            ).sessions;
          await sendAndWait("chat.send", parentKey, "Spawn one worker now.");
          expect(provider.spawn?.status).toBe("accepted");
          const child = provider.spawn;
          if (!child) {
            throw new Error("Parent did not receive sessions_spawn receipt");
          }
          expect((await wait(child.runId)).status).toBe("ok");
          const parentSessionId = (await sessions()).find(
            (entry) => entry.key === parentKey,
          )?.sessionId;
          expect(parentSessionId).toBeTypeOf("string");
          await sendAndWait("agent", child.childSessionKey, `Human followup ${WORKER}`);

          if (transition === "different store") {
            const { hash } = await gateway.client.request<{ hash: string }>("config.get", {});
            await gateway.client.request("config.patch", {
              baseHash: hash,
              raw: JSON.stringify({
                session: { store: newStore },
                agents: { defaults: { model: "proof/backup" } },
              }),
            });
            const keys = (await sessions()).map((entry) => entry.key);
            expect(keys).not.toContain(parentKey);
            expect(keys).not.toContain(child.childSessionKey);
            expect(provider.requests.map((request) => request.model)).not.toContain("backup");
          } else {
            expect(
              peekSystemEventEntries(parentKey).some(
                (event) =>
                  decodeSessionStateNoticeContextKey(event.contextKey ?? "") ===
                    child.childSessionKey && !isSystemEventTurnOwned(parentKey, event),
              ),
              "Child notice must still be passive before Gateway replacement",
            ).toBe(true);
            await disconnectGatewayClient(gateway.client);
            await gateway.server.close({ reason: "same-store replacement" });
            gateway = undefined;
            const replacementRequestOffset = provider.requests.length;
            const replacementNotice = provider.armNoticeObservation();
            sweepSettled = createDeferredCore();
            gateway = await start();
            await gateway.server.startupSettled;
            await withinTest(sweepSettled.promise, signal);
            // Restart restores unread notices as context for the next ordinary turn.
            await sendAndWait("chat.send", parentKey, "Continue after the Gateway restart.");
            const notice = await withinTest(replacementNotice, signal);
            expect(provider.requests.indexOf(notice)).toBeGreaterThanOrEqual(
              replacementRequestOffset,
            );
            expect(notice.model).toBe("primary");
            expect(JSON.stringify(notice.input)).toContain(child.childSessionKey);
            expect(JSON.stringify(notice.input)).toContain(WORKER);
            expect((await sessions()).find((entry) => entry.key === parentKey)?.sessionId).toBe(
              parentSessionId,
            );
          }
          expect(provider.errors).toEqual([]);
        },
        () => gateway && disconnectGatewayClient(gateway.client),
        () => gateway?.server.close({ reason: "heartbeat store proof complete" }),
        () => sweepSpy.mockRestore(),
        () => provider?.stop(),
        () => resetSubagentRegistryForTests({ persist: false }),
        () => removeGatewayTempHome(home.tempHome),
        () => home.envSnapshot.restore(),
        resetHeartbeatEventsForTest,
        resetGatewayTestState,
      );
    },
  );
});
