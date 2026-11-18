import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { createTrackedProvider } from "../src/gateway/test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../src/infra/device-identity.js";
import { createFeatureClient } from "../src/plugin-sdk/feature-contract.js";
import { connectProofClient } from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

const pluginId = "feature-diagnostic-proof";
const profile = "feature-diagnostic-proof";
const valueSchema = {
  type: "object",
  properties: { value: { type: "string" } },
  required: ["value"],
  additionalProperties: false,
};
const operations = Object.fromEntries(
  Array.from({ length: 80 }, (_, index) => [
    `operation-${index}`,
    {
      kind: index % 2 === 0 ? "query" : "action",
      description: "Synthetic feature operation",
      input: valueSchema,
      output: valueSchema,
      ...(index < 30 ? { tool: { name: `feature_operation_${index}` } } : {}),
    },
  ]),
);
const auxiliaryNames = Array.from({ length: 70 }, (_, index) => `feature_diagnostic_${index}`);
const source = `const { defineFeatureContract } = require("openclaw/plugin-sdk/feature-contract");
const { defineFeaturePlugin } = require("openclaw/plugin-sdk/feature-plugin");
const contract = defineFeatureContract(${JSON.stringify({ pluginId, operations, events: {} })});
const feature = defineFeaturePlugin({ contract, name: "Synthetic feature proof", description: "Synthetic runtime evidence", setup: () => Object.fromEntries(Object.keys(contract.operations).map(id => [id, input => input])) });
let preparationDelayed = false;
module.exports = { ...feature, register(api) {
  // Deliberate fixture-owned blocking work proves the real completed-registration timer.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
  feature.register(api);
  api.registerTool(context => {
    if (!preparationDelayed && context.sessionKey?.includes("diagnostic-proof")) {
      preparationDelayed = true;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5100);
    }
    return ${JSON.stringify(auxiliaryNames)}.map(name => ({ name, label: name, description: "Synthetic diagnostic fixture tool", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "fixture" }], details: { ok: true } }) }));
  }, { names: ${JSON.stringify(auxiliaryNames)} });
} };`;

// Explicit runtime tier: genuine controlled delays, a built CLI process, and a synthetic HTTP model.
it(
  "accepts large feature contracts and records real advisory diagnostics in a built Gateway",
  { timeout: 120_000 },
  async ({ signal, onTestFailed }) => {
    const providerToolCounts: number[] = [];
    const provider = createTrackedProvider(
      (raw, response) => {
        const request = JSON.parse(raw) as { tools?: unknown[] };
        providerToolCounts.push(request.tools?.length ?? 0);
        writeOpenAiResponsesText(response, {
          text: "SYNTHETIC_FEATURE_PROOF_COMPLETE",
          messageId: `proof_message_${providerToolCounts.length}`,
          responseId: `proof_response_${providerToolCounts.length}`,
        });
      },
      { signal },
    );
    let gateway: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof connectProofClient>> | undefined;
    const observations: Record<string, unknown> = {
      provider: "synthetic loopback OpenAI-compatible HTTP; no paid/live model",
      profile,
    };
    onTestFailed(() => {
      observations.startupDiagnostics = gateway
        ?.logs()
        .split(/\r?\n/u)
        .filter((line) =>
          /\[plugins|plugin registration|plugins.gateway-load|http server listening/iu.test(line),
        )
        .slice(-20)
        .map((line) => line.replaceAll(gateway!.state.root, "<isolated-state>"));
      process.stderr.write(
        JSON.stringify({
          proof: "built-feature-diagnostics-progress",
          ...observations,
          providerToolCounts,
        }) + "\n",
      );
    });
    await runQaGatewayFixture(
      async () => {
        const baseUrl = await provider.listen();
        const mock = buildMockOpenAiResponsesProvider(baseUrl, "feature-proof-model");
        gateway = await createOpenClawTestInstance({
          name: profile,
          signal,
          entrypoint: ["dist/index.js", "--profile", profile],
          gatewayToken: "synthetic-feature-proof-token",
          config: {
            // This is fresh current-version policy, not a legacy built-in Workshop configuration.
            meta: { migrations: { skillWorkshopPlugin: true } },
            agents: {
              ownership: "explicit",
              defaults: {
                workspace: "~/workspace",
                skipBootstrap: true,
                systemAgent: { agentId: "main" },
                model: { primary: mock.modelRef },
                params: { transport: "sse", openaiWsWarmup: false },
              },
              entries: { main: {}, filtered: { tools: { allow: [auxiliaryNames[0]] } } },
            },
            models: { mode: "replace", providers: { [mock.providerId]: mock.config } },
            tools: { profile: "full", allow: [pluginId], codeMode: true },
            plugins: { allow: [pluginId], slots: { memory: "none" } },
          },
          env: {
            OPENCLAW_PROFILE: profile,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OPENCLAW_AGENT_RUNTIME: undefined,
            NO_PROXY: [process.env.NO_PROXY, new URL(baseUrl).hostname].filter(Boolean).join(","),
            no_proxy: [process.env.no_proxy, new URL(baseUrl).hostname].filter(Boolean).join(","),
          },
        });
        const pluginRoot = gateway.state.statePath("fixture-plugin");
        await gateway.state.writeJson("fixture-plugin/package.json", {
          name: pluginId,
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await gateway.state.writeJson("fixture-plugin/openclaw.plugin.json", {
          id: pluginId,
          activation: { onStartup: true },
          configSchema: { type: "object" },
          contracts: {
            tools: [
              ...Object.values(operations).flatMap((operation) =>
                operation.tool ? [operation.tool.name] : [],
              ),
              ...auxiliaryNames,
            ],
          },
        });
        await gateway.state.writeText("fixture-plugin/index.cjs", source);
        const config = JSON.parse(await fs.readFile(gateway.configPath, "utf8"));
        config.plugins.load = { paths: [pluginRoot] };
        config.logging = {
          level: "info",
          consoleLevel: "info",
          file: gateway.state.path("gateway.log"),
        };
        await gateway.state.writeConfig(config);
        // The helper owns this process and profile; no installed service is inspected or changed.
        gateway.env.OPENCLAW_GATEWAY_PORT = String(gateway.port);
        await gateway.startGateway();
        await expect
          .poll(() => gateway!.logs().includes("plugin registration took"), { timeout: 30_000 })
          .toBe(true);
        observations.entrypoint = await gateway.entrypoint();
        observations.builtEntrypointSha256 = createHash("sha256")
          .update(await fs.readFile("dist/index.js"))
          .digest("hex");
        client = await connectProofClient(gateway, {
          signal,
          scopes: ["operator.read", "operator.write", "operator.admin"],
          deviceIdentity: loadOrCreateDeviceIdentity({
            path: gateway.state.path("client", "credentials.sqlite"),
          }),
        });
        const feature = createFeatureClient(
          {
            pluginId,
            operations: { "operation-78": { kind: "query" }, "operation-79": { kind: "action" } },
          },
          {
            pluginId,
            signal,
            connection: { connected: true },
            request: client.request.bind(client),
            onEvent: () => () => {},
            subscribe: () => () => {},
          },
        );
        const query = await feature.invoke("operation-78", { value: "built-query" });
        const action = await feature.invoke("operation-79", { value: "built-action" });
        expect(query).toEqual({ value: "built-query" });
        expect(action).toEqual({ value: "built-action" });
        observations.uiOnlyCalls = { query78: query, action79: action };
        for (const [sessionKey, id] of [
          ["agent:main:diagnostic-proof", "first"],
          ["agent:main:diagnostic-proof", "repeat"],
          ["agent:filtered:diagnostic-proof", "filtered"],
        ] as const) {
          const started = await client.request<{ runId: string; status: string }>("chat.send", {
            sessionKey,
            message: "Complete this synthetic fixture turn.",
            deliver: false,
            idempotencyKey: `feature-proof-${id}`,
          });
          expect(started.status).toBe("started");
          const finished = await client.request<{
            status: string;
            terminalReply?: { text?: string };
          }>("agent.wait", { runId: started.runId, timeoutMs: 45_000 }, { timeoutMs: 50_000 });
          expect(finished.status).toBe("ok");
          expect(finished.terminalReply?.text).toBe("SYNTHETIC_FEATURE_PROOF_COMPLETE");
          observations[id] = { status: finished.status, reply: finished.terminalReply?.text };
        }
        const lines = gateway.logs().split(/\r?\n/u);
        const registration = lines.filter(
          (line) => line.includes(pluginId) && line.includes("plugin registration took"),
        );
        const preparation = lines.filter((line) => line.includes("tool preparation completed"));
        const catalog = lines.filter((line) => line.includes("effective session tool catalog"));
        observations.sanitizedActualLogs = [...registration, ...preparation, ...catalog].map(
          (line) => line.replaceAll(gateway!.state.root, "<isolated-state>"),
        );
        expect(registration.length).toBeGreaterThan(0);
        expect(preparation.length).toBeGreaterThan(0);
        expect(catalog).toHaveLength(1);
        expect(catalog[0]).toContain("agent=main");
        expect(catalog[0]).toContain("catalog contains 100 tools");
        expect(providerToolCounts).toEqual([2, 2, 2]);
        observations.providerAdvertisedToolCounts = providerToolCounts;
        const artifact = process.env.OPENCLAW_FEATURE_PROOF_RECEIPT;
        if (artifact) {
          assert.ok(path.resolve(artifact).startsWith(path.resolve(".openclaw/tmp") + path.sep));
          await fs.mkdir(path.dirname(artifact), { recursive: true });
          await fs.writeFile(artifact, JSON.stringify(observations, null, 2) + "\n");
        }
        process.stderr.write(
          JSON.stringify({ proof: "built-feature-diagnostics", ...observations }) + "\n",
        );
      },
      () => client && disconnectGatewayClient(client),
      () => gateway?.cleanup(),
      () => provider.close(),
    );
  },
);
