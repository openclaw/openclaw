import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { withBuiltGateway } from "./helpers/built-gateway-proof.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { awaitGateBeforeSettlement, createDeferred } from "./helpers/promise.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

it(
  "cancels a provider request through the first chat RPC on a built Gateway",
  { timeout: 120_000 },
  async () => {
    const modelId = "cold-cancel-model";
    const runId = randomUUID();
    const sessionKey = "agent:main:cold-agent-abort";
    const accepted = createDeferred<unknown>();
    const providerReceived = createDeferred<Record<string, unknown>>();
    let providerRequests = 0;
    let providerAborted = false;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === "GET" && request.url === "/v1/models") {
          respondJson(response, { data: [{ id: modelId, object: "model" }] });
          return;
        }
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        const body = JSON.parse(await readRequestText(request)) as Record<string, unknown>;
        providerRequests += 1;
        // Keep the provider response open: only cancellation may close it before cleanup.
        response.once("close", () => {
          providerAborted = !response.writableFinished;
        });
        providerReceived.resolve(body);
      })().catch((error: unknown) => {
        providerReceived.reject(error);
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    let final: Promise<unknown> | undefined;
    await runQaGatewayFixture(
      async () => {
        const provider = buildMockOpenAiResponsesProvider(
          `${await listenLoopback(server)}/v1`,
          modelId,
        );
        await withBuiltGateway(
          {
            name: "cold-agent-abort",
            config: {
              plugins: { slots: { memory: "none" } },
              agents: {
                entries: { main: {} },
                defaults: {
                  model: { primary: provider.modelRef, fallbacks: [] },
                  models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
                  skills: [],
                },
              },
              tools: { profile: "minimal" },
              models: {
                mode: "replace",
                providers: {
                  [provider.providerId]: {
                    ...provider.config,
                    request: { allowPrivateNetwork: true },
                  },
                },
              },
            } satisfies OpenClawConfig,
            env: {
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
              OPENCLAW_SKIP_PROVIDERS: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            },
          },
          async (client) => {
            final = client.request(
              "agent",
              {
                agentId: "main",
                sessionKey,
                idempotencyKey: runId,
                message: "Wait for cancellation.",
                deliver: false,
                timeout: 30,
              },
              { expectFinal: true, timeoutMs: 30_000, onAccepted: accepted.resolve },
            );
            await expect(
              awaitGateBeforeSettlement(
                Promise.all([accepted.promise, providerReceived.promise]),
                final,
                "agent completed before the cancellation request",
              ),
            ).resolves.toMatchObject([{ runId, status: "accepted" }, { model: modelId }]);
            expect(providerAborted).toBe(false);

            // Readiness uses HTTP and setup uses only agent: this is the first chat-family RPC.
            expect(await client.request("chat.abort", { sessionKey, runId })).toMatchObject({
              aborted: true,
              runIds: [runId],
            });
            // The agent RPC retains its cancellation wire status; agent.wait retains the terminal outcome.
            expect(await final).toEqual({
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "rpc",
            });
            expect(await client.request("agent.wait", { runId, timeoutMs: 1_000 })).toMatchObject({
              status: "error",
              stopReason: "rpc",
            });
            await vi.waitFor(() => expect(providerAborted).toBe(true), { timeout: 5_000 });
            expect(providerRequests).toBe(1);
          },
        );
      },
      () => server.listening && closeHttpServer(server),
      () => Promise.allSettled(final ? [final] : []),
    );
  },
);
