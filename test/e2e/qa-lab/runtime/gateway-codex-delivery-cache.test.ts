import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  startQaBusServer,
  startQaMockOpenAiServer,
  type MockOpenAiRequestSnapshot,
} from "../../../../extensions/qa-lab/api.js";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../../../scripts/lib/local-build-metadata.mts";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// The provider is scripted; the Gateway, pinned Codex app-server, dynamic message
// execution and channel transport are real. This proves wire stability, not model compliance.
describe("Codex delivery-mode prompt caching", () => {
  it(
    "keeps one native session and static request bytes across alternating Gateway turns",
    {
      timeout: 240_000,
    },
    async () => {
      const repoRoot = process.cwd();
      const head = resolveGitHead({ cwd: repoRoot });
      expect(head).toMatch(/^[0-9a-f]{40}$/u);
      for (const [file, field] of [
        [BUILD_STAMP_FILE, "head"],
        [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
        ["build-info.json", "commit"],
      ] as const) {
        const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, "dist", file), "utf8"));
        expect(metadata[field], file).toBe(head);
      }
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
          const deliveryRequestsByTurn: MockOpenAiRequestSnapshot[] = [];
          const fragmentBytes: number[] = [];
          for (const [index, mode] of ["automatic", "message_tool_only", undefined].entries()) {
            const cursor = (await readRequests()).at(-1)?.cursor ?? 0;
            const sinceIndex = state
              .getSnapshot()
              .messages.filter((m) => m.direction === "outbound").length;
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
            const completed = (await gateway.call(
              "agent.wait",
              {
                runId: accepted.runId,
                timeoutMs: 60_000,
              },
              { timeoutMs: 65_000 },
            )) as { status: string; error?: string };
            expect(completed, gateway.logs()).toMatchObject({ status: "ok" });
            const outbound = await transport.waitForOutbound({
              conversation,
              sinceIndex,
              textIncludes: "QA-MESSAGE-DELIVERY-OK",
              timeoutMs: 10_000,
            });
            expect(outbound.text).toBe("QA-MESSAGE-DELIVERY-OK\n\nQA-MESSAGE-DELIVERY-OK");
            expect(
              state.getSnapshot().messages.filter((m) => m.direction === "outbound").length -
                sinceIndex,
            ).toBe(1);
            const requests = (await readRequests()).filter((request) => request.cursor > cursor);
            const deliveryRequests = requests.filter(
              (request) => request.plannedToolName === "message",
            );
            expect(deliveryRequests).toHaveLength(1);
            const deliveryRequest = deliveryRequests[0]!;
            deliveryRequestsByTurn.push(deliveryRequest);
            const input = deliveryRequest.body.input as Array<{
              role?: string;
              content?: unknown;
            }>;
            expect(Array.isArray(input)).toBe(true);
            const currentUser = input.findLastIndex(
              (item) => item.role === "user" && JSON.stringify(item.content).includes(message),
            );
            const policyIndex = input.findLastIndex(
              (item) =>
                item.role === "developer" &&
                JSON.stringify(item.content).includes("<openclaw_source_delivery>"),
            );
            expect(policyIndex).toBeGreaterThanOrEqual(0);
            expect(currentUser).toBeGreaterThan(policyIndex);
            const policy = JSON.stringify(input[policyIndex]?.content);
            expect(policy).toContain("replaces earlier source-delivery guidance");
            expect(policy).toContain("current source is default target");
            expect(policy).toContain(
              mode === "message_tool_only"
                ? "not automatically delivered"
                : "delivers your final response automatically",
            );
            fragmentBytes.push(Buffer.byteLength(policy));
            expect(fragmentBytes.at(-1)).toBeLessThan(1_000);
            if (index > 0) {
              expect(
                input
                  .slice(0, policyIndex)
                  .some(
                    (item) =>
                      item.role === "user" &&
                      JSON.stringify(item.content).includes(`cache turn ${index - 1}`),
                  ),
              ).toBe(true);
              // The prompt cache key remains stable across the reused native session.
              expect(deliveryRequest.body.prompt_cache_key).toBe(
                deliveryRequestsByTurn[0]!.body.prompt_cache_key,
              );
              expect(deliveryRequest.body.instructions).toBe(
                deliveryRequestsByTurn[0]!.body.instructions,
              );
              expect(JSON.stringify(deliveryRequest.body.tools)).toBe(
                JSON.stringify(deliveryRequestsByTurn[0]!.body.tools),
              );
            }
            expect(deliveryRequest.body.prompt_cache_key).toEqual(expect.any(String));
            expect(deliveryRequest.body.instructions).toEqual(expect.any(String));
            expect(deliveryRequest.body.tools).toEqual(expect.any(Array));
          }
          console.info(
            "[codex-delivery-cache-runtime-proof]",
            JSON.stringify({
              head,
              turns: deliveryRequestsByTurn.length,
              nativeSessions: new Set(
                deliveryRequestsByTurn.map((request) => request.body.prompt_cache_key),
              ).size,
              instructionsSha256: createHash("sha256")
                .update(String(deliveryRequestsByTurn[0]!.body.instructions))
                .digest("hex"),
              toolsSha256: createHash("sha256")
                .update(JSON.stringify(deliveryRequestsByTurn[0]!.body.tools))
                .digest("hex"),
              fragmentBytes,
              deliveredMessages: state
                .getSnapshot()
                .messages.filter((m) => m.direction === "outbound").length,
            }),
          );
        },
        () => stopQaGatewayFixture(owner),
        () => mock?.stop(),
        () => bus?.stop(),
      );
    },
  );
});
