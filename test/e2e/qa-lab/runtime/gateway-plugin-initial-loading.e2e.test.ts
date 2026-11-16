import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { text as readBody } from "node:stream/consumers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { withFastReplyConfig } from "../../../../src/auto-reply/reply/get-reply-fast-path.test-support.js";
import { getRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { resolvePluginArtifactDeclaredSurface } from "../../../../src/plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../../../../src/plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../../../../src/plugins/capability-summary.js";
import * as generationWorker from "../../../../src/plugins/plugin-generation-worker.js";
import { seedInstalledPluginIndex } from "../../../../src/plugins/test-helpers/installed-plugin-index.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../../src/utils/message-channel.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../../helpers/openai-responses-model-fixture.js";
import {
  writeOpenAiResponsesSse,
  writeOpenAiResponsesText,
} from "../../../helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { isolatedGatewayEnv } from "./gateway-recovery.test-support.js";
import { resetGatewayState } from "./gateway-startup-routing.test-support.js";

// Gateway, loader, worker, agent and tool are real; only model HTTP is synthetic.
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(resetGatewayState);
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayState();
});

it(
  "loads an initial plugin dependency graph while foreground work continues, then runs its tool",
  { timeout: 120_000 },
  async ({ signal }) => {
    const home = tempDirs.make("openclaw-initial-plugin-");
    const stateDir = path.join(home, ".openclaw");
    const workspaceDir = path.join(home, "workspace");
    const bundledPluginsDir = path.join(home, "empty-bundled");
    const pluginRoot = path.join(home, "initial-probe");
    const dependency = path.join(pluginRoot, "node_modules", "initial-dependency");
    const configPath = path.join(stateDir, "openclaw.json");
    await Promise.all(
      [stateDir, workspaceDir, bundledPluginsDir, dependency].map((dir) =>
        fs.mkdir(dir, { recursive: true, mode: 0o700 }),
      ),
    );
    await Promise.all([
      fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "initial-probe",
          version: "1.0.0",
          dependencies: { "initial-dependency": "1.0.0" },
          openclaw: { extensions: ["./index.cjs"] },
        }),
      ),
      fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "initial-probe",
          contracts: { tools: ["initial_probe"] },
          configSchema: { type: "object", additionalProperties: false },
        }),
      ),
      fs.writeFile(
        path.join(dependency, "package.json"),
        JSON.stringify({ name: "initial-dependency", version: "1.0.0", main: "index.cjs" }),
      ),
      fs.writeFile(path.join(dependency, "index.cjs"), 'module.exports = require("./leaf.cjs");'),
      fs.writeFile(path.join(dependency, "leaf.cjs"), 'module.exports = "initial-dependency-42";'),
      fs.writeFile(
        path.join(pluginRoot, "index.cjs"),
        'const value = require("initial-dependency"); module.exports = { id: "initial-probe", register(api) { api.registerTool({ name: "initial_probe", label: "Initial probe", description: "Read the initial dependency sentinel", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: value }] }; } }); } };',
      ),
    ]);
    const token = randomUUID();
    const sessionKey = "agent:main:dashboard:" + randomUUID();
    const delivered = createDeferred();
    const failure = createDeferred<Error>();
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let provider: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    let preparing = false;
    let progress = 0;
    let synchronousWorkerWaits = 0;
    const prepare = generationWorker.preparePluginGenerationArtifact;
    vi.spyOn(generationWorker, "preparePluginGenerationArtifact").mockImplementation(
      async (params) => {
        if (params.rootDir !== pluginRoot) {
          return prepare(params);
        }
        preparing = true;
        try {
          return await prepare(params);
        } finally {
          preparing = false;
        }
      },
    );
    const wait = Atomics.wait;
    vi.spyOn(Atomics, "wait").mockImplementation((...args) => {
      if (new Error().stack?.includes("plugin-generation-worker")) {
        synchronousWorkerWaits++;
      }
      return wait(...args);
    });
    const ticker = setInterval(() => {
      if (preparing) {
        progress++;
      }
    }, 1);
    try {
      await withEnvAsync(
        {
          ...isolatedGatewayEnv,
          HOME: home,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_GATEWAY_TOKEN: token,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          ALL_PROXY: undefined,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          all_proxy: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          NO_PROXY: "127.0.0.1,localhost",
          no_proxy: "127.0.0.1,localhost",
        },
        async () => {
          try {
            provider = await startOpenAiResponsesModelServer({
              modelId: "qa-initial-plugin",
              bindError: "provider bind failed",
              onRequest: async (request, response) => {
                try {
                  const body = JSON.parse(await readBody(request)) as {
                    instructions?: string;
                    tools?: Array<{ name?: string }>;
                    input: Array<{
                      role?: string;
                      type?: string;
                      call_id?: string;
                      output?: string;
                      content?: unknown;
                    }>;
                  };
                  const output = body.input.find(
                    (item) =>
                      item.type === "function_call_output" && item.call_id === "call_initial",
                  );
                  if (
                    JSON.stringify([
                      body.instructions,
                      ...body.input.filter(
                        (item) => item.role === "developer" || item.role === "system",
                      ),
                    ]).includes("Generate a concise session title")
                  ) {
                    writeOpenAiResponsesText(response, {
                      text: "Initial plugin proof",
                      messageId: "title",
                      responseId: "title",
                    });
                  } else if (output) {
                    expect(output.output).toContain("initial-dependency-42");
                    writeOpenAiResponsesText(response, {
                      text: "Initial plugin dependency verified.",
                      messageId: "final",
                      responseId: "final",
                    });
                  } else {
                    expect(body.tools?.some((tool) => tool.name === "initial_probe")).toBe(true);
                    const item = {
                      type: "function_call",
                      id: "fc_initial",
                      call_id: "call_initial",
                      name: "initial_probe",
                      arguments: "{}",
                    };
                    writeOpenAiResponsesSse(response, [
                      {
                        type: "response.output_item.added",
                        output_index: 0,
                        item: { ...item, arguments: "" },
                      },
                      {
                        type: "response.function_call_arguments.delta",
                        item_id: item.id,
                        output_index: 0,
                        delta: item.arguments,
                      },
                      { type: "response.output_item.done", output_index: 0, item },
                      {
                        type: "response.completed",
                        response: {
                          id: "resp_initial",
                          status: "completed",
                          output: [item],
                          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                        },
                      },
                    ]);
                  }
                } catch (error) {
                  failure.resolve(error instanceof Error ? error : new Error(String(error)));
                  response.end();
                }
              },
            });
            const cfg = createOpenAiResponsesModelConfig({
              baseUrl: provider.baseUrl,
              providerId: "mock-openai",
              modelId: "qa-initial-plugin",
              reasoning: false,
              toolProfile: "full",
            });
            cfg.agents!.defaults!.workspace = workspaceDir;
            cfg.agents!.defaults!.models = {
              "mock-openai/qa-initial-plugin": {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            };
            cfg.agents!.entries = { main: {} };
            cfg.plugins = {
              slots: { memory: "none" },
              enabled: true,
              allow: ["initial-probe"],
              load: { paths: [pluginRoot] },
            };
            cfg.tools = { allow: ["initial_probe"], codeMode: false, toolSearch: false };
            cfg.gateway = { auth: { mode: "token", token } };
            await fs.writeFile(configPath, JSON.stringify(cfg));
            await seedInstalledPluginIndex(
              {
                "initial-probe": {
                  source: "path",
                  sourcePath: pluginRoot,
                  installPath: pluginRoot,
                },
              },
              { env: process.env, config: cfg },
            );
            await resolvePluginCapabilityConsent({
              config: cfg,
              pluginId: "initial-probe",
              env: process.env,
              acknowledge: {
                reviewToken: computeDeclaredSurfaceHash(
                  resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, { config: cfg }),
                ),
              },
            });
            gateway = await startGatewayWithClient({
              cfg,
              configPath,
              token,
              origin: "http://127.0.0.1",
              clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
              scopes: ["operator.admin"],
              onEvent: (event) => {
                if (
                  event.event === "chat" &&
                  (event.payload as { state?: string })?.state === "final" &&
                  JSON.stringify(event.payload).includes("Initial plugin dependency verified.")
                ) {
                  delivered.resolve();
                }
              },
            });
            await gateway.server.startupSettled;
            expect(
              progress,
              "foreground timer ran during the actual initial preparation",
            ).toBeGreaterThan(0);
            expect(
              synchronousWorkerWaits,
              "binding and require never synchronously wait on the preparation worker",
            ).toBe(0);
            const runtime = getRuntimeConfigSnapshot();
            assert(runtime);
            withFastReplyConfig(runtime);
            await gateway.client.request("chat.send", {
              sessionKey,
              message: "Use initial_probe to verify the dependency.",
              deliver: false,
              idempotencyKey: randomUUID(),
            });
            await withinTest(
              Promise.race([
                delivered.promise,
                failure.promise.then((error) => {
                  throw error;
                }),
              ]),
              signal,
            );
            const history = await gateway.client.request<{ messages: unknown[] }>("chat.history", {
              sessionKey,
            });
            expect(JSON.stringify(history.messages)).toContain(
              "Initial plugin dependency verified.",
            );
          } finally {
            try {
              if (gateway) {
                try {
                  await disconnectGatewayClient(gateway.client);
                } finally {
                  await gateway.server.close({ reason: "Isolated initial plugin proof complete" });
                }
              }
            } finally {
              await provider?.close();
            }
          }
        },
      );
    } finally {
      clearInterval(ticker);
    }
  },
);
