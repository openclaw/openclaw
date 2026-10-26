import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../packages/gateway-protocol/src/schema/audit-run.js";
import type { UsersSelfResult } from "../../packages/gateway-protocol/src/schema/users.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { AgentWaitResult } from "../agents/run-wait.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatFixture } from "./gateway-chat-fixture.test-support.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

it(
  "retains authenticated Control UI attach identity through chat.send execution and replay",
  { timeout: 90_000 },
  () =>
    withOpenClawTestState(
      {
        label: "chat-send-attach-identity",
        env: {
          ...KERNEL_TEST_ENV,
          VITEST: process.env.VITEST,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        },
      },
      async () => {
        const finalText = "attach-identity-provider-proof";
        const clientIdentity = { id: "openclaw-control-ui", mode: "webchat" } as const;
        const fixture = createChatFixture("attach-identity", {
          respond: async () => finalText,
          configure: (cfg) => ({
            ...cfg,
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
            logging: { audit: { executionIdentity: true } },
          }),
        });
        const audit = await import("../audit/audit-event-writer.js");
        const auditFactory = vi.spyOn(audit, "createAuditEventWriter");
        await runQaGatewayFixture(
          async () => {
            await fixture.start();
            const client = fixture.client;
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
            expect(fixture.requests).toEqual([expect.stringContaining(params.message)]);
            const historyParams = { sessionKey: created.key, limit: 20 };
            const readHistory = () =>
              client.request<{ messages: unknown[] }>("chat.history", historyParams);
            const history = await readHistory();
            expect(history.messages).toMatchObject([
              {
                role: "user",
                content: params.message,
                __openclaw: {
                  idempotencyKey: `${runId}:user`,
                  senderIdentity: { type: "profile", id: self.profile.id },
                  transport: { clients: [clientIdentity] },
                },
              },
              {
                role: "assistant",
                content: [{ type: "text", text: finalText }],
                __openclaw: { runId },
              },
            ]);
            expect(await client.request("chat.send", params)).toMatchObject({ runId });
            expect((await readHistory()).messages).toEqual(history.messages);
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.errors).toEqual([]);
            const writers = auditFactory.mock.results.flatMap((result) =>
              result.type === "return" ? [result.value] : [],
            );
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
          () => fixture.close(),
          () => auditFactory.mockRestore(),
        );
      },
    ),
);
