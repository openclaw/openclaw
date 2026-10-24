// Real isolated Gateway proof: both invocation surfaces receive the saved-session catalog.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { expect, it, onTestFinished, vi } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "./helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const MODEL = "catalog-proof";
const SESSION_KEY = "agent:main:catalog-proof";
const MARKER = "CATALOG_TOOL_CONTINUED";

it(
  "exposes the requester catalog to a plugin command and v2 tool in an isolated Gateway",
  { timeout: 240_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-catalog-proof-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const requests: Array<{ input?: unknown[] }> = [];
    const server = await startOpenAiResponsesModelServer({
      modelId: MODEL,
      bindError: "catalog model fixture did not bind",
      onRequest: async (request, response) => {
        requests.push((await json(request)) as { input?: unknown[] });
        if (requests.length !== 1) {
          writeOpenAiResponsesText(response, {
            text: MARKER,
            messageId: "msg_catalog",
            responseId: "resp_catalog_final",
          });
          return;
        }
        const item = {
          type: "function_call",
          id: "fc_catalog",
          call_id: "call_catalog",
          name: "catalog_probe",
          arguments: "{}",
          status: "completed",
        };
        writeOpenAiResponsesSse(response, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: "{}",
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_catalog_tool",
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        ]);
      },
    });
    onTestFinished(() => server.close());
    const bundledRoot = path.join(root, "bundled");
    const pluginDir = path.join(bundledRoot, "catalog-proof");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "catalog-proof",
        activation: { onStartup: true },
        contracts: { tools: ["catalog_probe"] },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      'module.exports = {\n  id: "catalog-proof",\n  register(api) {\n    if (!api.runtime.capabilities?.includes("requester-model-catalog-v1")) throw new Error("catalog capability missing");\n    api.registerCommand({ name: "catalog-proof", description: "Catalog smoke", runtimeCapabilities: ["models"], handler: async (ctx) => ({ text: JSON.stringify(await ctx.runtimeContext?.models?.list() ?? "unavailable") }) });\n    api.registerTool({ contextVersion: 2, create: (ctx) => ({ name: "catalog_probe", label: "Catalog", description: "Read requester catalog", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: JSON.stringify(await ctx.runtimeContext?.models?.list() ?? "unavailable") }] }) }) }, { name: "catalog_probe", workspaceAccess: false });\n  }\n};',
    );
    const config = createOpenAiResponsesModelConfig({
      baseUrl: server.baseUrl,
      providerId: MODEL,
      modelId: MODEL,
      reasoning: false,
      toolProfile: "minimal",
    });
    config.plugins = { entries: { "catalog-proof": { enabled: true } }, slots: { memory: "none" } };
    config.tools = {
      profile: "minimal",
      alsoAllow: ["catalog_probe"],
      codeMode: false,
      toolSearch: false,
    };
    const instance = await createOpenClawTestInstance({
      name: "plugin-requester-catalog",
      config,
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    onTestFinished(() => instance.cleanup());
    try {
      await instance.startGateway();
      const events: Array<{ event?: string; payload?: unknown }> = [];
      const client = await connectGatewayClient({
        url: instance.url,
        token: instance.gatewayToken,
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
        onEvent: (event) => events.push(event),
      });
      try {
        const response = await client.request<{
          status?: string;
          result?: { payloads?: Array<{ text?: string }> };
        }>(
          "agent",
          {
            sessionKey: SESSION_KEY,
            message: "Call catalog_probe and report completion.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 120_000 },
        );
        expect(response).toMatchObject({
          status: "ok",
          result: { payloads: expect.arrayContaining([expect.objectContaining({ text: MARKER })]) },
        });
        expect(requests).toHaveLength(2);
        const output = requests[1]!.input!.find(
          (item) =>
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "function_call_output",
        ) as { output: string } | undefined;
        expect(output).toBeDefined();
        expect(
          output!.output,
          "the real tool must return the catalog, not a tool-call error",
        ).toMatch(/^\{/);
        const toolCatalog = JSON.parse(output!.output);
        expect(toolCatalog).toMatchObject({
          state: "prepared",
          models: [{ provider: MODEL, id: MODEL }],
        });
        const runId = randomUUID();
        await client.request("chat.send", {
          sessionKey: SESSION_KEY,
          message: "/catalog-proof",
          deliver: false,
          idempotencyKey: runId,
        });
        let message: unknown;
        await vi.waitFor(
          () => {
            const final = events.find(
              (event) =>
                event.event === "chat" &&
                typeof event.payload === "object" &&
                event.payload !== null &&
                "runId" in event.payload &&
                event.payload.runId === runId &&
                "state" in event.payload &&
                event.payload.state === "final",
            );
            expect(final).toBeDefined();
            message = (final!.payload as { message?: unknown }).message;
          },
          { timeout: 45_000, interval: 20 },
        );
        expect(JSON.parse(extractFirstTextBlock(message) ?? "null")).toEqual(toolCatalog);
        expect(requests).toHaveLength(2); // A command read does not invoke the model.
      } finally {
        await disconnectGatewayClient(client);
      }
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    }
  },
);
