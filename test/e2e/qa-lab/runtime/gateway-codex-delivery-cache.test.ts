import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import { verifyBuiltGatewayHead } from "../../../helpers/gateway-built-fixture.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { waitForRun } from "./gateway-recovery.test-support.js";

// The provider is scripted; the Gateway, pinned Codex app-server, dynamic message
// execution and channel transport are real. This proves wire stability, not model compliance.
it(
  "keeps one native session and static request bytes across alternating Gateway turns",
  { timeout: 240_000 },
  async ({ signal }) => {
    const repoRoot = process.cwd();
    await verifyBuiltGatewayHead(repoRoot, signal);
    const state = createQaBusState();
    const transport = createQaChannelTransport(state);
    const owner = createQaGatewayChild();
    let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    await runQaGatewayFixture(
      async () => {
        bus = await startQaBusServer({ state });
        mock = await startQaMockOpenAiServer({ modelRefs: ["openai/gpt-5.6-luna"] });
        const mockBaseUrl = mock.baseUrl;
        const gateway = await owner.start({
          repoRoot,
          forcedRuntime: "codex",
          providerMode: "mock-openai",
          providerBaseUrl: `${mockBaseUrl}/v1`,
          primaryModel: "openai/gpt-5.6-luna",
          alternateModel: "openai/gpt-5.6-luna",
          transport,
          transportBaseUrl: bus.baseUrl,
          controlUiEnabled: false,
          mutateConfig: (config) => ({
            ...config,
            tools: { ...config.tools, alsoAllow: ["message"] },
          }),
        });
        await transport.waitReady({ gateway });
        const readRequests = async () => {
          const response = await fetch(`${mockBaseUrl}/debug/requests`);
          expect(response.status).toBe(200);
          return (await response.json()) as MockOpenAiRequestSnapshot[];
        };
        const conversation = { id: "delivery-cache", kind: "direct" as const };
        let firstRequest: { key: unknown; instructions: string; tools: string } | undefined;
        const outboundCount = () =>
          state.getSnapshot().messages.filter((m) => m.direction === "outbound").length;
        for (const [index, mode] of ["automatic", "message_tool_only", undefined].entries()) {
          const cursor = (await readRequests()).at(-1)?.cursor ?? 0;
          const sinceIndex = outboundCount();
          const message = `message delivery decision send qa check: cache turn ${index}`;
          // Direct RPC has no auto-reply prompt prelude. Its prepared mode must still
          // reach the native turn, including an omitted mode restoring the default.
          const accepted = (await gateway.call("agent", {
            agentId: "qa",
            sessionKey: "agent:qa:delivery-cache",
            message,
            ...transport.buildAgentDelivery({ target: conversation.id }),
            to: conversation.id,
            deliver: true,
            ...(mode ? { sourceReplyDeliveryMode: mode } : {}),
            idempotencyKey: randomUUID(),
          })) as { status: string; runId: string };
          expect(accepted.status).toBe("accepted");
          const completed = await waitForRun(gateway, accepted.runId, 60_000, 65_000);
          expect(completed, gateway.logs()).toMatchObject({ status: "ok" });
          const outbound = await transport.waitForOutbound({
            conversation,
            sinceIndex,
            textIncludes: "QA-MESSAGE-DELIVERY-OK",
            timeoutMs: 10_000,
          });
          expect(outbound.text).toBe("QA-MESSAGE-DELIVERY-OK\n\nQA-MESSAGE-DELIVERY-OK");
          expect(outboundCount() - sinceIndex).toBe(1);
          const deliveryRequests = (await readRequests()).filter(
            (request) => request.cursor > cursor && request.plannedToolName === "message",
          );
          expect(deliveryRequests).toHaveLength(1);
          const { body } = deliveryRequests[0]!;
          const input = body.input as Array<{ role?: string; content?: unknown }>;
          // Codex 0.162 prepends base instructions as a developer input item.
          const instructions = input[0];
          expect(instructions).toMatchObject({
            role: "developer",
            content: [{ type: "input_text", text: expect.stringMatching(/\S/u) }],
          });
          const identity = {
            key: body.prompt_cache_key,
            instructions: JSON.stringify(instructions),
            tools: JSON.stringify(body.tools),
          };
          const contains = (role: string, fragment: string) => (item: (typeof input)[number]) =>
            item.role === role && JSON.stringify(item.content).includes(fragment);
          const currentUser = input.findLastIndex(contains("user", message));
          const policyIndex = input.findLastIndex(
            contains("developer", "<openclaw_source_delivery>"),
          );
          expect(currentUser).toBeGreaterThan(policyIndex);
          const policy = JSON.stringify(input[policyIndex]?.content);
          expect(policy).toContain("replaces earlier source-delivery guidance");
          expect(policy).toContain("current source is default target");
          expect(policy).toContain(
            mode === "message_tool_only"
              ? "not automatically delivered"
              : "delivers your final response automatically",
          );
          expect(Buffer.byteLength(policy)).toBeLessThan(1_000);
          if (index > 0) {
            expect(
              input.slice(0, policyIndex).some(contains("user", `cache turn ${index - 1}`)),
            ).toBe(true);
            expect(identity).toEqual(firstRequest);
          }
          firstRequest ??= identity;
          expect(body).toMatchObject({
            prompt_cache_key: expect.any(String),
            tools: expect.any(Array),
          });
        }
      },
      () => stopQaGatewayFixture(owner),
      () => mock?.stop(),
      () => bus?.stop(),
    );
  },
);
