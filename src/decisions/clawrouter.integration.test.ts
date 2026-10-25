import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  resetDecisionTestRuntime,
  activateDecisionRegistry,
  decisionOptions,
} from "../agents/decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDecisionModels } from "../gateway/server-methods/models-list-capabilities.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  evaluateDecisionV2InRegistry,
  inspectDecisionProviders,
  prepareDecisionProviderReload,
} from "./runtime.js";
import type { DecisionBatchV2 } from "./types-v2.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "A damaged parcel" },
  questions: {
    damaged: { type: "boolean", instructions: "Is it damaged?" },
  },
};
const catalog = {
  providers: [
    {
      id: "openai",
      displayName: "OpenAI",
      openaiCompatible: true,
      nativeBaseUrl: "/v1/native/openai",
      routes: [{ path: "/v1/decisions", requestFormat: "openai.decisions", methods: ["POST"] }],
      models: [
        { id: "openai/gpt-6-luna", upstream: "gpt-6-luna", capabilities: ["llm.decisions"] },
      ],
    },
  ],
};
const nativeResult = {
  model: "gpt-6-luna",
  answers: [{ name: "damaged", type: "predicate", probability: 0.9 }],
  usage: { input_tokens: 12, output_tokens: 0 },
};
function routerConfig(origin: string, root: string, selector: string) {
  return {
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        decisionModel: selector === "default" ? "clawrouter/openai/gpt-6-luna" : "",
      },
      entries: {
        main: selector === "per-agent" ? { decisionModel: "clawrouter/openai/gpt-6-luna" } : {},
        quiet: { decisionModel: "" },
      },
    },
    models: {
      providers: {
        clawrouter: {
          baseUrl: origin,
          apiKey: "synthetic-router-only",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          // Custom endpoints need an authored row; native implicit inventory is host-scoped.
          models: [
            {
              id: "openai/gpt-6-luna",
              name: "Fixture Luna",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 2048,
            },
          ],
        },
      },
    },
    plugins: { allow: ["clawrouter"], slots: { memory: "none" } },
  } satisfies OpenClawConfig;
}
afterEach(() => resetDecisionTestRuntime());

it.each(["default", "per-agent"])(
  "evaluates the %s selector through the registered ClawRouter owner and prepared native HTTP route",
  async (selector) =>
    withOpenClawTestState(
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENAI_API_KEY: "synthetic-must-not-be-used",
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
        },
      },
      async (state) => {
        const requests: Array<{ path?: string; auth?: string; body: unknown }> = [];
        let holdInference = false;
        const inferenceReceived = Promise.withResolvers<void>();
        const inferenceClosed = Promise.withResolvers<void>();
        await withServer(
          (request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              requests.push({
                path: request.url,
                auth: request.headers.authorization,
                body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
              });
              response.setHeader("content-type", "application/json");
              if (holdInference && request.url === "/v1/native/openai/v1/decisions") {
                response.on("close", () => inferenceClosed.resolve());
                response.write("{");
                inferenceReceived.resolve();
                return;
              }
              response.end(JSON.stringify(request.url === "/v1/catalog" ? catalog : nativeResult));
            });
          },
          async (origin) => {
            const config = routerConfig(origin, state.root, selector);
            const registry = await activateDecisionRegistry(config, {
              onlyPluginIds: ["clawrouter"],
              pluginSdkResolution: "src",
              preferBuiltPluginArtifacts: false,
              cache: false,
            });
            const evaluate = (agentId = "main", signal?: AbortSignal) =>
              evaluateDecisionV2InRegistry(
                batch,
                { ...decisionOptions({ agentId }), ...(signal ? { signal } : {}) },
                registry,
                config,
              );
            const expectIdle = () =>
              expect(inspectDecisionProviders(config, registry)).toContainEqual(
                expect.objectContaining({ providerId: "clawrouter", activeRequests: 0 }),
              );
            try {
              await using prepared = await acquireAgentRunPreparedModelRuntime(
                {
                  config,
                  agentId: "main",
                  agentDir: resolveAgentDir(config, "main"),
                  workspaceDir: config.agents.defaults.workspace,
                  loadRuntimePlugins: true,
                  runtimePluginSelections: [
                    { provider: "clawrouter", modelId: "openai/gpt-6-luna", agentId: "main" },
                  ],
                },
                { catalogMode: "static" },
              );
              expect(
                prepared.snapshot.modelCatalog.entries.filter(
                  (entry) => entry.provider === "clawrouter",
                ),
                "prepared router decision row",
              ).toContainEqual(expect.objectContaining({ id: "openai/gpt-6-luna" }));
              const outcome = await evaluate();
              expect(outcome.status, JSON.stringify({ outcome, requests })).toBe("ok");
              expect(
                listDecisionModels({ config, snapshot: prepared.snapshot.metadataSnapshot }),
              ).toContainEqual(
                expect.objectContaining({
                  provider: "clawrouter",
                  id: "openai/gpt-6-luna",
                  pluginId: "clawrouter",
                  capabilities: {
                    questionTypes: ["boolean", "choice", "score"],
                    maxQuestions: 400,
                    maxChoiceAlternatives: 255,
                    confidence: "provider-specific",
                  },
                }),
              );
              expect(outcome).toMatchObject({
                status: "ok",
                result: {
                  model: "gpt-6-luna",
                  answers: {
                    damaged: { type: "boolean", probabilityTrue: 0.9 },
                  },
                  usage: { inputTokens: 12, outputTokens: 0 },
                },
                provenance: { providerId: "clawrouter" },
              });
              expect(requests).toContainEqual({
                path: "/v1/native/openai/v1/decisions",
                auth: "Bearer synthetic-router-only",
                body: {
                  model: "gpt-6-luna",
                  input: "A damaged parcel",
                  questions: [
                    { name: "damaged", type: "predicate", instructions: "Is it damaged?" },
                  ],
                },
              });
              expectIdle();
              const beforeDisabled = requests.length;
              expect(await evaluate("quiet")).toMatchObject({
                status: "unavailable",
                reason: "disabled",
              });
              expect(requests).toHaveLength(beforeDisabled);
              if (selector === "default") {
                holdInference = true;
                const controller = new AbortController();
                const pending = evaluate("main", controller.signal);
                await Promise.race([inferenceReceived.promise, pending]);
                const aborted = expect(pending).rejects.toThrow("fixture caller stopped");
                controller.abort(new Error("fixture caller stopped"));
                await aborted;
                await inferenceClosed.promise;
                expectIdle();
              }
            } finally {
              prepareDecisionProviderReload(registry, new Set(["clawrouter"]));
              for (const record of registry.plugins) {
                await getPluginInstance(record)?.dispose();
              }
            }
          },
        );
      },
    ),
);
