// An opted-in Claude 5 route streams before the refusal decision; the Gateway withdraws only the refused call.
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../src/config/types.models.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { createDeferred } from "./helpers/promise.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);

const PROVIDER_ID = "streamed-anthropic";
const MODEL_ID = "claude-sonnet-5-5";
const TOKEN = "anthropic-stream-before-refusal-token";
const FIRST_CALL = "FIRST_CALL_KEPT";
const REFUSED_PARTIAL = "REFUSED_PARTIAL_WITHDRAWN";

type AgentEvent = { stream?: string; data?: Record<string, unknown> };

const assistantText = (data: Record<string, unknown>) =>
  [data.text, data.delta].filter((value) => typeof value === "string").join("");

function sse(response: ServerResponse, events: Record<string, unknown>[]) {
  response.write(
    events
      .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      .join(""),
  );
}

const messageStart = (id: string) => ({
  type: "message_start",
  message: {
    id,
    type: "message",
    role: "assistant",
    model: MODEL_ID,
    content: [],
    stop_reason: null,
    usage: { input_tokens: 80, output_tokens: 0 },
  },
});
const textBlock = (index: number, text: string) => [
  { type: "content_block_start", index, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index },
];
const writeCall = (index: number, id: string, file: string) => [
  {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name: "write", input: {} },
  },
  {
    type: "content_block_delta",
    index,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({ path: file, content: "ran" }),
    },
  },
  { type: "content_block_stop", index },
];
const stop = (stop_reason: string) => [
  {
    type: "message_delta",
    delta: {
      stop_reason,
      stop_sequence: null,
      ...(stop_reason === "refusal"
        ? { stop_details: { type: "refusal", category: "cyber", explanation: null } }
        : {}),
    },
    usage: { output_tokens: 12 },
  },
  { type: "message_stop" },
];

function provider(baseUrl: string) {
  const model: ModelDefinitionConfig = {
    id: MODEL_ID,
    name: "Opted-in Claude Sonnet 5.5",
    api: "anthropic-messages",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    compat: { streamBeforeRefusal: true },
  };
  const config: ModelProviderConfig = {
    baseUrl,
    apiKey: "sk-ant-api03-stream-before-refusal", // pragma: allowlist secret
    api: "anthropic-messages",
    models: [model],
  };
  return { providerId: PROVIDER_ID, modelRef: `${PROVIDER_ID}/${MODEL_ID}`, config } as const;
}

it(
  "streams an opted-in call live, withdraws only the refused call, and runs none of its tools",
  { timeout: 90_000 },
  async () => {
    const fixture = await createFixture("openclaw-stream-before-refusal-", TOKEN);
    const homeDir = path.dirname(fixture.stateDir);
    const requests: Array<{ scenario: string; toolResult: boolean }> = [];
    const agentEvents: Array<{ runId?: string; stream?: string; data: Record<string, unknown> }> =
      [];
    // The provider holds the refusal until the client has received the partial it ends.
    const partialSeen = createDeferred();
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let client: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
    try {
      providerServer = createServer((request, response) => {
        let raw = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.on("end", () => {
          const body = JSON.parse(raw) as { messages?: Array<{ role: string; content: unknown }> };
          const serialized = JSON.stringify(body.messages ?? []);
          const scenario = serialized.includes("[two-calls]")
            ? "two-calls"
            : serialized.includes("[tool-refusal]")
              ? "tool-refusal"
              : "untagged";
          const toolResult = serialized.includes('"tool_result"');
          requests.push({ scenario, toolResult });
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          sse(response, [messageStart(`msg_${requests.length}`)]);
          if (scenario === "two-calls" && !toolResult) {
            sse(response, [
              ...textBlock(0, FIRST_CALL),
              ...writeCall(1, "toolu_first", "FIRST_CALL_RAN.txt"),
              ...stop("tool_use"),
            ]);
            response.end();
          } else if (scenario === "two-calls") {
            sse(response, [
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: REFUSED_PARTIAL },
              },
            ]);
            void partialSeen.promise.then(() => {
              sse(response, [{ type: "content_block_stop", index: 0 }, ...stop("refusal")]);
              response.end();
            });
          } else if (scenario === "tool-refusal") {
            sse(response, [
              ...writeCall(0, "toolu_refused", "REFUSED_CALL_RAN.txt"),
              ...stop("refusal"),
            ]);
            response.end();
          } else {
            sse(response, [...textBlock(0, "Title"), ...stop("end_turn")]);
            response.end();
          }
        });
      });
      const providerUrl = await listenProofProvider(providerServer);
      gateway = await startGatewayWithClient({
        cfg: fixture.config(provider(providerUrl)),
        configPath: fixture.configPath,
        token: TOKEN,
        clientDisplayName: "stream-before-refusal",
      });
      const observer = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token: TOKEN,
        clientDisplayName: "stream-before-refusal-tools",
        caps: ["tool-events"],
        onEvent: (evt) => {
          if (evt.event !== "agent") {
            return;
          }
          const payload = evt.payload as AgentEvent & { runId?: string };
          const data = payload.data ?? {};
          agentEvents.push({ runId: payload.runId, stream: payload.stream, data });
          if (payload.stream === "assistant" && assistantText(data).includes(REFUSED_PARTIAL)) {
            partialSeen.resolve();
          }
        },
      });
      client = observer;
      const run = async (scenario: string) => {
        const sessionKey = `agent:main:${scenario}`;
        const started = await observer.request<{ runId?: string; status?: string }>("chat.send", {
          sessionKey,
          message: `[${scenario}] go`,
          deliver: false,
          idempotencyKey: `stream-before-refusal-${scenario}`,
        });
        expect(started.status).toBe("started");
        const waited = await observer.request<{ status?: string }>(
          "agent.wait",
          { runId: started.runId, timeoutMs: 30_000 },
          { timeoutMs: 35_000 },
        );
        const history = await observer.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey,
          limit: 20,
        });
        return {
          runId: started.runId,
          waited,
          history: JSON.stringify(history.messages ?? []),
          events: agentEvents.filter((event) => event.runId === started.runId),
        };
      };

      const twoCalls = await run("two-calls");
      expect(twoCalls.waited.status).toBe("error");
      const assistant = twoCalls.events.filter((event) => event.stream === "assistant");
      const itemOf = (marker: string) =>
        assistant.find((event) => assistantText(event.data).includes(marker))?.data.itemId;
      const firstItem = itemOf(FIRST_CALL);
      const refusedItem = itemOf(REFUSED_PARTIAL);
      expect(firstItem).toBeDefined();
      expect(refusedItem).toBeDefined();
      expect(refusedItem).not.toBe(firstItem);
      // The refused call's live text is replaced with nothing; the first call's text is untouched.
      expect(
        assistant.filter((event) => event.data.replace === true && event.data.text === ""),
      ).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ itemId: refusedItem }) }),
      ]);
      expect(twoCalls.history).toContain(FIRST_CALL);
      expect(twoCalls.history).toContain('"toolCallId":"toolu_first"');
      expect(twoCalls.history).not.toContain(REFUSED_PARTIAL);

      const toolRefusal = await run("tool-refusal");
      expect(toolRefusal.waited.status).toBe("error");
      expect(toolRefusal.events.filter((event) => event.stream === "tool")).toEqual([]);
      expect(toolRefusal.history).not.toContain("toolu_refused");

      expect(requests.filter((request) => request.scenario !== "untagged")).toEqual([
        { scenario: "two-calls", toolResult: false },
        { scenario: "two-calls", toolResult: true },
        { scenario: "tool-refusal", toolResult: false },
      ]);
      const files = (await fs.readdir(homeDir, { recursive: true })).map(String);
      expect(files.some((file) => file.endsWith("FIRST_CALL_RAN.txt"))).toBe(true);
      expect(files.some((file) => file.endsWith("REFUSED_CALL_RAN.txt"))).toBe(false);
    } finally {
      partialSeen.resolve();
      if (client) {
        await disconnectGatewayClient(client).catch(() => undefined);
      }
      await fixture.close(gateway, providerServer, true);
    }
  },
);
