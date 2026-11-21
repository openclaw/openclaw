import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, test } from "vitest";
import { z } from "zod";
import { truncateToolResultMessage } from "../src/agents/embedded-agent-runner/tool-result-truncation.js";
import { resolveLiveToolResultMaxChars } from "../src/agents/tool-result-limits.js";
import { loadTranscriptReadSnapshotSync } from "../src/config/sessions/session-accessor.sqlite-read.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { writeRestartPlugin, writeRestartToolCalls } from "./gateway-restart.test-support.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import { startOpenAiResponsesModelServer } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";

const SESSION_KEY = "agent:main:tool-prefix-proof";
const TOOL = "prefix_records";
const PLUGIN = "prefix-proof";
const CALL_ID = "call_prefix_records";
const IMAGE =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=";
const wirePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("input_image"), image_url: z.string() }),
]);
const wireRequestSchema = z.object({
  model: z.string(),
  tools: z.array(z.object({ type: z.string(), name: z.string().optional() })).optional(),
  input: z.array(
    z.object({
      type: z.string().optional(),
      call_id: z.string().optional(),
      output: z.union([z.string(), z.array(wirePartSchema)]).optional(),
    }),
  ),
});
type WireRequest = z.infer<typeof wireRequestSchema>;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function output(request: WireRequest): { text: string; images: string[] } {
  const item = request.input.find(
    (entry) => entry.type === "function_call_output" && entry.call_id === CALL_ID,
  );
  if (!item || item.output === undefined) {
    throw new Error("Provider request omitted the fixture tool result");
  }
  if (typeof item.output === "string") {
    return { text: item.output, images: [] };
  }
  return {
    text: item.output.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join(""),
    images: item.output.flatMap((part) =>
      part.type === "input_image" && part.image_url ? [part.image_url] : [],
    ),
  };
}

test(
  "Gateway preserves a compacted mixed-media tool prefix through shrink and reopen",
  { timeout: 240_000 },
  async () => {
    const fixtureDir = await mkdtemp(path.join(tmpdir(), "openclaw-prefix-proof-"));
    const pluginDir = path.join(fixtureDir, "plugin");
    const requests: WireRequest[] = [];
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    const server = await startOpenAiResponsesModelServer({
      modelId: "prefix-wide",
      bindError: "Prefix proof model did not bind",
      onRequest: async (request, response) => {
        const captured = wireRequestSchema.parse(await json(request));
        requests.push(captured);
        if (requests.length === 1) {
          expect(captured.tools?.some((tool) => tool.name === TOOL)).toBe(true);
          writeRestartToolCalls(response, "resp_prefix_tool", [
            {
              type: "function_call",
              id: "fc_prefix",
              call_id: CALL_ID,
              name: TOOL,
              arguments: "{}",
              status: "completed",
            },
          ]);
        } else {
          writeOpenAiResponsesText(response, {
            text: "Prefix proof complete.",
            messageId: "msg_prefix_" + requests.length,
            responseId: "resp_prefix_" + requests.length,
          });
        }
      },
    });
    try {
      const rows = Array.from({ length: 1_000 }, (_, index) => ({
        type: "text" as const,
        text:
          "record-" + String(index + 1).padStart(4, "0") + " | " + "payload ".repeat(14).trimEnd(),
      }));
      const content = [
        ...rows.slice(0, 70),
        { type: "image" as const, mimeType: "image/png", data: IMAGE },
        ...rows.slice(70),
      ];
      const pluginSource = [
        "export default { id: " + JSON.stringify(PLUGIN) + ", register(api) { api.registerTool({",
        "name: " +
          JSON.stringify(TOOL) +
          ", label: 'Prefix Records', description: 'Return the synthetic mixed-media record page.',",
        "parameters: { type: 'object', properties: {}, additionalProperties: false },",
        "async execute() {",
        "return { content: " + JSON.stringify(content) + ", details: {} };",
        "} }); } };",
      ].join("\n");
      await writeRestartPlugin(
        pluginDir,
        {
          id: PLUGIN,
          name: "Prefix Proof",
          activation: { onStartup: true },
          contracts: { tools: [TOOL] },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        pluginSource,
      );
      const config: OpenClawConfig = {
        plugins: {
          allow: ["openai", PLUGIN],
          load: { paths: [pluginDir] },
          slots: { memory: "none" },
          entries: { [PLUGIN]: { enabled: true } },
        },
        agents: {
          defaults: {
            model: { primary: "openai/prefix-wide" },
            models: {
              "openai/prefix-wide": { agentRuntime: { id: "openclaw" } },
              "openai/prefix-tight": { agentRuntime: { id: "openclaw" } },
            },
            utilityModel: "",
            skipBootstrap: true,
            skills: [],
          },
        },
        tools: { profile: "minimal", codeMode: false, toolSearch: false, alsoAllow: [TOOL] },
        models: {
          mode: "replace",
          providers: {
            openai: {
              baseUrl: server.baseUrl + "/v1",
              apiKey: "synthetic-prefix-proof-only",
              api: "openai-responses",
              request: { allowPrivateNetwork: true },
              models: (
                [
                  ["prefix-wide", 128_000],
                  ["prefix-tight", 64_000],
                ] as const
              ).map(([id, contextWindow]) => ({
                id,
                name: id,
                api: "openai-responses" as const,
                reasoning: false,
                input: ["text" as const, "image" as const],
                contextWindow,
                maxTokens: 1_024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            },
          },
        },
      };
      instance = await createOpenClawTestInstance({
        name: "tool-prefix-reopen",
        config,
        env: { OPENCLAW_SKIP_PROVIDERS: undefined, OPENCLAW_TEST_MINIMAL_GATEWAY: undefined },
      });
      const connect = () => {
        if (!instance) {
          throw new Error("Missing isolated instance");
        }
        return connectProofClient(instance, {
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
      };
      await instance.startGateway();
      client = await connect();
      const turn = async (message: string) => {
        if (!client) {
          throw new Error("Prefix proof client is disconnected");
        }
        const runId = randomUUID();
        const result = await client.request<{
          status: string;
          runId: string;
          result?: { payloads?: Array<{ text?: string }> };
        }>(
          "agent",
          { sessionKey: SESSION_KEY, message, deliver: false, idempotencyKey: runId },
          { expectFinal: true, timeoutMs: 60_000 },
        );
        expect(result).toMatchObject({
          status: "ok",
          runId,
          result: {
            payloads: expect.arrayContaining([
              expect.objectContaining({ text: "Prefix proof complete." }),
            ]),
          },
        });
      };
      await turn("Call prefix_records once, then acknowledge the page.");
      expect(requests).toHaveLength(2);
      const wideRequest = expectDefined(requests[1], "Initial tool continuation request");
      const wide = output(wideRequest);
      expect(wideRequest.model).toBe("prefix-wide");
      expect(wide.images).toEqual(["data:image/png;base64," + IMAGE]);
      expect(wide.text).toContain("record-0001 | payload");
      expect(wide.text).not.toContain("record-1000");
      expect(wide.text.match(/more characters truncated/gu)).toHaveLength(1);
      const listed = await client.request<{ sessions: Array<{ key: string; sessionId: string }> }>(
        "sessions.list",
        { includeGlobal: true, limit: 20 },
      );
      const sessionId = listed.sessions.find((row) => row.key === SESSION_KEY)?.sessionId;
      if (!sessionId) {
        throw new Error("Gateway did not return the durable session id");
      }
      const readCanonical = () => {
        if (!instance) {
          throw new Error("Missing isolated instance");
        }
        const snapshot = loadTranscriptReadSnapshotSync(
          {
            agentId: "main",
            sessionId,
            sessionKey: SESSION_KEY,
            storePath: path.join(instance.state.agentDir("main"), "openclaw-agent.sqlite"),
            maxEventBytes: 2_000_000,
          },
          { readOnly: true },
        );
        const entries = snapshot.events
          .filter(isRecord)
          .filter(
            (entry) =>
              isRecord(entry.message) &&
              entry.message.role === "toolResult" &&
              entry.message.toolCallId === CALL_ID + "|fc_prefix",
          );
        expect(entries).toHaveLength(1);
        return expectDefined(entries[0], "Canonical fixture tool event");
      };
      const canonical = readCanonical();
      const message = canonical.message;
      if (!isRecord(message) || !Array.isArray(message.content)) {
        throw new Error("Missing canonical tool content");
      }
      // Canonical history retains the live persistence cap, not the raw producer page.
      const expectedCanonical = truncateToolResultMessage(
        {
          role: "toolResult",
          toolCallId: CALL_ID + "|fc_prefix",
          toolName: TOOL,
          content,
          isError: false,
          timestamp: 0,
        },
        resolveLiveToolResultMaxChars({ contextWindowTokens: 128_000 }),
      );
      expect(message.content).toEqual(expectedCanonical.content);
      expect(message.content).toHaveLength(257);
      expect(message.content[70]).toMatchObject({
        type: "image",
        mimeType: "image/png",
        data: IMAGE,
      });
      expect(message.content[256]).toMatchObject({
        type: "text",
        text: "[... 93125 more characters truncated; rerun with narrower args if needed]",
      });
      await client.request("sessions.patch", { key: SESSION_KEY, model: "openai/prefix-tight" });
      await turn("Acknowledge the existing page without another tool call.");
      expect(requests).toHaveLength(3);
      const tightRequest = expectDefined(requests[2], "Tighter-budget continuation request");
      expect(tightRequest.model).toBe("prefix-tight");
      const tight = output(tightRequest);
      expect(tight.images).toEqual(wide.images);
      expect(tight.text).toContain("record-0001 | payload");
      expect(tight.text.match(/more characters truncated/gu)).toHaveLength(1);
      expect(tight.text.length).toBeLessThan(wide.text.length);
      expect(readCanonical()).toEqual(canonical);
      await disconnectGatewayClient(client);
      client = undefined;
      await instance.stopGateway();
      await instance.startGateway();
      client = await connect();
      await client.request("sessions.patch", { key: SESSION_KEY, model: "openai/prefix-wide" });
      await turn("Acknowledge the same existing page after reopening; do not call tools.");
      expect(requests).toHaveLength(4);
      const reopenedRequest = expectDefined(
        requests[3],
        "Reopened wide-budget continuation request",
      );
      expect(reopenedRequest.model).toBe("prefix-wide");
      expect(output(reopenedRequest)).toEqual(tight);
      expect(readCanonical()).toEqual(canonical);
    } catch (error) {
      throw new Error("Prefix proof failed after " + requests.length + " provider requests.", {
        cause: error,
      });
    } finally {
      try {
        if (client) {
          await disconnectGatewayClient(client);
        }
      } finally {
        try {
          if (instance) {
            await instance.cleanup();
          }
        } finally {
          await server.close();
          await rm(fixtureDir, { recursive: true, force: true });
        }
      }
    }
  },
);
