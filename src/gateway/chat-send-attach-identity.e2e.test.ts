import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../packages/gateway-protocol/src/schema/audit-run.js";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import type { AuditEventWriter } from "../audit/audit-event-writer.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

async function startProvider(requests: string[], finalText: string) {
  return await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          requests.push(Buffer.concat(chunks).toString("utf8"));
          const message = {
            type: "message",
            id: randomUUID(),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: finalText, annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                id: randomUUID(),
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => response.writeHead(500).end(String(error)));
      }),
  });
}

it(
  "retains authenticated Control UI attach identity through chat.send execution and replay",
  { timeout: 90_000 },
  async () => {
    await withOpenClawTestState(
      {
        label: "chat-send-attach-identity",
        env: {
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async (state) => {
        state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = state.path("no-plugins");
        state.applyEnv();
        const requests: string[] = [];
        const finalText = "attach-identity-provider-proof";
        let providerServer: Awaited<ReturnType<typeof startProvider>> | undefined;
        let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
        const audit = await import("../audit/audit-event-writer.js");
        const createAuditWriter = audit.createAuditEventWriter;
        const writers: AuditEventWriter[] = [];
        const auditFactory = vi
          .spyOn(audit, "createAuditEventWriter")
          .mockImplementation((options) => {
            const writer = createAuditWriter(options);
            writers.push(writer);
            return writer;
          });
        await runQaGatewayFixture(
          async () => {
            providerServer = await startProvider(requests, finalText);
            const provider = buildMockOpenAiResponsesProvider(
              `http://127.0.0.1:${providerServer.claim.port}/v1`,
              "attach-identity-proof",
            );
            const token = "synthetic-attach-identity-token";
            const cfg = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  skipBootstrap: true,
                  model: { primary: provider.modelRef },
                  models: {
                    [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                  },
                },
              },
              gateway: {
                auth: { mode: "token", token },
                controlUi: { allowedOrigins: ["http://localhost"] },
              },
              models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
              plugins: { slots: { memory: "none" } },
              tools: { profile: "minimal" },
              logging: { audit: { executionIdentity: true } },
            } satisfies OpenClawConfig;
            gateway = await startGatewayWithClient({
              cfg,
              configPath: state.configPath,
              token,
              clientName: "openclaw-control-ui",
              mode: "webchat",
              origin: "http://localhost",
              scopes: ["operator.admin", "operator.read", "operator.write"],
            });
            const client = gateway.client;
            const self = await client.request<UsersSelfResult>("users.self", {});
            expect(self.profile.id).toBe("gateway-owner");
            const created = await client.request<{ key: string }>("sessions.create", {
              agentId: "main",
              label: "Attach identity proof",
            });
            const runId = randomUUID();
            const params = {
              sessionKey: created.key,
              message: "attach-identity-user-proof",
              idempotencyKey: runId,
            };
            expect(await client.request("chat.send", params)).toMatchObject({
              runId,
              status: "started",
            });
            const completed = await client.request<AgentWaitResult>(
              "agent.wait",
              { runId, timeoutMs: 30_000 },
              { timeoutMs: 35_000 },
            );
            expect(completed).toMatchObject({
              status: "ok",
              terminalReply: { disposition: "visible", text: finalText },
            });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toContain(params.message);
            const historyParams = { sessionKey: created.key, limit: 20 };
            const history = await client.request<{ messages: unknown[] }>(
              "chat.history",
              historyParams,
            );
            expect(history.messages).toMatchObject([
              {
                role: "user",
                content: params.message,
                __openclaw: {
                  idempotencyKey: `${runId}:user`,
                  senderIdentity: { type: "profile", id: self.profile.id },
                  transport: {
                    clients: [{ id: "openclaw-control-ui", mode: "webchat" }],
                  },
                },
              },
              {
                role: "assistant",
                content: [{ type: "text", text: finalText }],
                __openclaw: { runId },
              },
            ]);
            expect(await client.request("chat.send", params)).toMatchObject({ runId });
            const replayHistory = await client.request<{ messages: unknown[] }>(
              "chat.history",
              historyParams,
            );
            expect(replayHistory.messages).toEqual(history.messages);
            expect(requests).toHaveLength(1);
            expect(writers).toHaveLength(1);
            // Turn completion does not drain diagnostic persistence. Keep the real
            // writer live through replay, then join its FIFO before inspecting it.
            await writers[0]!.stop();
            const inspected = await client.request<AuditRunInspectResult>("audit.run.inspect", {
              runId,
            });
            expect(inspected.identity).toMatchObject({
              state: "present",
              context: {
                runId,
                ingress: {
                  kind: "gateway-client",
                  state: "present",
                  boundary: "gateway.ws.authenticated-connect",
                },
                invoker: { state: "present", principal: { kind: "person" } },
                assurance: expect.arrayContaining([
                  expect.objectContaining({
                    kind: "durable-profile",
                    strength: "boundary-verified",
                  }),
                ]),
              },
            });
          },
          () => (gateway ? disconnectGatewayClient(gateway.client) : undefined),
          () => gateway?.server.close({ reason: "attach identity proof complete" }),
          async () => {
            providerServer?.listener.closeAllConnections();
            await providerServer?.releaseListener();
          },
          () => providerServer?.claim.release(),
          () => auditFactory.mockRestore(),
        );
      },
    );
  },
);
