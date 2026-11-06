import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { visitQaSqliteTranscriptEvents } from "../../../../src/plugin-sdk/qa-runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../../../src/state/openclaw-agent-db.paths.js";
import { closeHttpServer } from "../../../helpers/gateway-integration-fixtures.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { listenLoopback, sendChat } from "./gateway-recovery.test-support.js";

const REFUSAL_EXPLANATION = "Service unavailable. Try again.";
const REFUSAL_TEXT =
  "The provider refused this request (category: reasoning_extraction). Revise the request and try again.";
// Canonical refusal guidance is public; raw provider explanations stay private.
const REFUSAL_NOTICE = `Your request couldn't be completed: ${REFUSAL_TEXT}`;

type GatewayHistory = {
  messages?: Array<{ role?: unknown; content?: unknown; customType?: unknown }>;
};

function messageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  return (Array.isArray(content) ? content : [])
    .flatMap((part) =>
      part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
        ? [(part as { text: string }).text]
        : [],
    )
    .join("\n");
}

async function startRefusingAnthropicProvider() {
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
      }
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          { type: "message_start", message: { id: "msg_refusal", usage: {} } },
          {
            type: "message_delta",
            delta: {
              stop_reason: "refusal",
              stop_details: {
                type: "refusal",
                category: "reasoning_extraction",
                explanation: REFUSAL_EXPLANATION,
              },
            },
            usage: { input_tokens: 3, output_tokens: 0 },
          },
          { type: "message_stop" },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
      );
    })().catch((error: unknown) => {
      response.writeHead(500).end(error instanceof Error ? error.message : String(error));
    });
  });
  const baseUrl = await listenLoopback(server, "refusal provider did not bind a loopback port");
  return {
    baseUrl,
    requests,
    stop: () => closeHttpServer(server),
  };
}

it("keeps a structured Anthropic refusal terminal across retry and fallback", async () => {
  const provider = await startRefusingAnthropicProvider();
  const gatewayOwner = createQaGatewayChild();
  await runQaGatewayFixture(
    async () => {
      const gateway = await gatewayOwner.start({
        repoRoot: process.cwd(),
        command: {
          executablePath: process.execPath,
          argsPrefix: ["dist/entry.js"],
          cwd: process.cwd(),
          tempParentDir: process.env.TMPDIR ?? tmpdir(),
          usePackagedPlugins: false,
        },
        providerBaseUrl: provider.baseUrl,
        providerMode: "mock-openai",
        primaryModel: "anthropic/claude-opus-4-8",
        alternateModel: "anthropic/claude-sonnet-4-6",
        transportBaseUrl: "http://127.0.0.1",
        controlUiEnabled: false,
        runtimeEnvPatch: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        },
        mutateConfig: ({ plugins: _plugins, ...config }) => config,
      });

      const sessionKey = `agent:qa:provider-refusal-${randomUUID()}`;
      const started = await sendChat(
        gateway,
        sessionKey,
        "Trigger the deterministic provider refusal.",
      );
      expect(started).toMatchObject({ status: "started", runId: expect.any(String) });

      const terminal = (await gateway.call(
        "agent.wait",
        { runId: started.runId, timeoutMs: 30_000 },
        { timeoutMs: 35_000 },
      )) as { status?: unknown; error?: unknown };
      const history = (await gateway.call(
        "chat.history",
        { sessionKey, limit: 20 },
        { timeoutMs: 10_000 },
      )) as GatewayHistory;
      const refusals =
        history.messages?.filter(
          (message) =>
            message.role === "custom" && message.customType === "run-failed-before-reply",
        ) ?? [];
      expect(provider.requests).toEqual([expect.objectContaining({ model: "claude-opus-4-8" })]);
      expect(terminal).toMatchObject({ status: "error", error: REFUSAL_TEXT });
      expect(refusals).toHaveLength(1);
      expect(messageText(refusals[0]?.content)).toBe(REFUSAL_NOTICE);
      expect(refusals[0]).toMatchObject({
        display: true,
        openclawRunError: { runId: started.runId, summary: REFUSAL_NOTICE },
      });
      expect(refusals[0]).not.toHaveProperty("details.error");
      expect(JSON.stringify({ terminal, history })).not.toContain(REFUSAL_EXPLANATION);

      const receipts: Record<string, unknown>[] = [];
      await gateway.stop({
        beforeTempCleanup: () =>
          visitQaSqliteTranscriptEvents(
            resolveOpenClawAgentSqlitePath({ agentId: "qa", env: gateway.runtimeEnv }),
            (eventJson) => {
              const entry: unknown = JSON.parse(eventJson);
              if (isRecord(entry) && entry.customType === "run-failed-before-reply") {
                receipts.push(entry);
              }
            },
          ),
      });
      expect(receipts).toEqual([
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          content: REFUSAL_NOTICE,
          display: true,
          excludeFromContext: true,
          details: { runId: started.runId, error: REFUSAL_TEXT },
        }),
      ]);
      expect(JSON.stringify(receipts)).not.toContain(REFUSAL_EXPLANATION);
    },
    () => stopQaGatewayFixture(gatewayOwner),
    () => provider.stop(),
  );
}, 60_000);
