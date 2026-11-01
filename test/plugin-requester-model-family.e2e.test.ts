// Real isolated Gateway proof: catalog-declared model families reach the plugin requester reader.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { connectGatewayClient, disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import type { PluginRequesterModelCatalog } from "../src/plugins/model-catalog.types.js";
import { extractFirstTextBlock } from "../src/shared/chat-message-content.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

const CUSTOM = "family-proof";
const SESSION_KEY = "agent:main:family-proof";

// Configured ClawRouter refs whose ids name a vendor. With a custom endpoint the plugin's
// discovered inventory is not eligible, so no catalog metadata describes these rows.
const ROUTED = ["anthropic/claude-opus-5-5", "openai/gpt-6.1-sol"];

it(
  "gives the requester reader a bundled catalog's family and infers none for undeclared models",
  { timeout: 300_000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-family-proof-"));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST" && url.pathname === "/v1/responses") {
        writeOpenAiResponsesText(response, {
          text: "ready",
          messageId: "msg_family",
          responseId: "resp_family",
        });
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("family fixture did not bind");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const pluginDir = path.join(root, "family-reader");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "family-reader",
        activation: { onStartup: true },
        configSchema: { type: "object", additionalProperties: false },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      'module.exports = {\n  id: "family-reader",\n  register(api) {\n    api.registerCommand({ name: "family-proof", description: "Family smoke", runtimeCapabilities: ["models"], handler: async (ctx) => ({ text: JSON.stringify(await ctx.runtimeContext?.models?.list() ?? "unavailable") }) });\n  }\n};',
    );

    const config = createOpenAiResponsesModelConfig({
      baseUrl,
      providerId: CUSTOM,
      modelId: CUSTOM,
      reasoning: false,
      toolProfile: "minimal",
    });
    // Merge keeps the bundled catalogs; replace would publish only this config's provider.
    config.models = {
      ...config.models,
      mode: "merge",
      providers: {
        ...config.models?.providers,
        clawrouter: { baseUrl: `${baseUrl}/v1`, models: [] },
      },
    };
    const visible = [
      `${CUSTOM}/${CUSTOM}`,
      // Kimi Code serves Moonshot's models from a static bundled catalog: no live discovery.
      "kimi/k3",
      ...ROUTED.map((id) => `clawrouter/${id}`),
    ];
    config.agents!.defaults!.models = Object.fromEntries(
      visible.map((ref) => [
        ref,
        ref === `${CUSTOM}/${CUSTOM}` ? { agentRuntime: { id: "openclaw" } } : {},
      ]),
    );
    config.plugins = {
      ...config.plugins,
      load: { paths: [pluginDir] },
      entries: { "family-reader": { enabled: true } },
    };
    const instance = await createOpenClawTestInstance({
      name: "plugin-requester-family",
      config,
      env: {
        CLAWROUTER_API_KEY: "synthetic-router-key",
        KIMICODE_API_KEY: "synthetic-kimi-key",
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
        // A saved session row is the reader's authority; one model turn creates it.
        await client.request(
          "agent",
          {
            sessionKey: SESSION_KEY,
            message: "Say ready.",
            deliver: false,
            idempotencyKey: randomUUID(),
          },
          { expectFinal: true, timeoutMs: 120_000 },
        );
        const readCatalog = async () => {
          const runId = randomUUID();
          await client.request("chat.send", {
            sessionKey: SESSION_KEY,
            message: "/family-proof",
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
          return JSON.parse(
            extractFirstTextBlock(message) ?? "null",
          ) as PluginRequesterModelCatalog;
        };
        // Read until the prepared inventory is published for the requester's session.
        let catalog: PluginRequesterModelCatalog | undefined;
        await vi.waitFor(
          async () => {
            catalog = await readCatalog();
            expect(catalog.state).toBe("prepared");
            expect(
              catalog.models.map(({ provider, id }) => `${provider}/${id}`).toSorted(),
            ).toEqual(visible.toSorted());
          },
          { timeout: 120_000, interval: 1_000 },
        );
        const families = Object.fromEntries(
          catalog!.models.map((model) => [`${model.provider}/${model.id}`, model.family]),
        );
        expect(families).toEqual({
          [`${CUSTOM}/${CUSTOM}`]: undefined,
          "kimi/k3": "moonshot",
          // The ids name vendors, but no catalog declares these rows: nothing is inferred.
          "clawrouter/anthropic/claude-opus-5-5": undefined,
          "clawrouter/openai/gpt-6.1-sol": undefined,
        });
        for (const model of catalog!.models) {
          if (model.family === undefined) {
            expect(model, `${model.provider}/${model.id}`).not.toHaveProperty("family");
          }
        }
        expect(JSON.stringify(catalog)).not.toMatch(
          /synthetic-router-key|synthetic-kimi-key|test-token-placeholder|apiKey|authProfile/,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    } catch (error) {
      throw new Error(String(error) + "\n" + instance.logs(), { cause: error });
    }
  },
);
