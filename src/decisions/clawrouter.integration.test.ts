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
import { withEnvAsync } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
    route: { type: "choice", criteria: { support: "Damage", sales: "Orders" } },
    urgency: { type: "score", criteria: ["Routine", "Urgent"] },
    withheld: { type: "boolean" },
  },
};
afterEach(() => resetDecisionTestRuntime());

it.each(["default", "per-agent"])(
  "evaluates the %s selector through the registered ClawRouter owner and prepared native HTTP route",
  async (selector) => {
    const state = await createOpenClawTestState({ applyEnv: false });
    const requests: Array<{ path?: string; auth?: string; body: unknown }> = [];
    let holdInference = false;
    const inferenceReceived = Promise.withResolvers<void>();
    const inferenceClosed = Promise.withResolvers<void>();
    try {
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
            response.end(
              JSON.stringify(
                request.url === "/v1/catalog"
                  ? {
                      providers: [
                        {
                          id: "openai",
                          displayName: "OpenAI",
                          openaiCompatible: true,
                          nativeBaseUrl: "/v1/native/openai",
                          routes: [
                            {
                              path: "/v1/decisions",
                              requestFormat: "openai.decisions",
                              methods: ["POST"],
                            },
                          ],
                          models: [
                            {
                              id: "openai/gpt-6-luna",
                              upstream: "gpt-6-luna",
                              capabilities: ["llm.decisions"],
                            },
                          ],
                        },
                      ],
                    }
                  : {
                      model: "gpt-6-luna",
                      answers: [
                        { name: "damaged", type: "predicate", probability: 0.9 },
                        {
                          name: "route",
                          type: "choice",
                          choice: "support",
                          confidence: 0.8,
                          probabilities: [
                            { value: "sales", probability: 0.2 },
                            { value: "support", probability: 0.8 },
                          ],
                        },
                        {
                          name: "urgency",
                          type: "score",
                          score: 0.75,
                          confidence: 0.7,
                          probabilities: [
                            { label: "1", value: 1, probability: 0.75 },
                            { label: "0", value: 0, probability: 0.25 },
                          ],
                        },
                        { name: "withheld", type: "refusal" },
                      ],
                      usage: { input_tokens: 12, output_tokens: 0 },
                    },
              ),
            );
          });
        },
        async (origin) => {
          const config = {
            agents: {
              defaults: {
                workspace: path.join(state.root, "workspace"),
                decisionModel: selector === "default" ? "clawrouter/openai/gpt-6-luna" : "",
              },
              entries: {
                main:
                  selector === "per-agent" ? { decisionModel: "clawrouter/openai/gpt-6-luna" } : {},
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
          await withEnvAsync(
            {
              ...state.envVars,
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
            async () => {
              const registry = await activateDecisionRegistry(config, {
                onlyPluginIds: ["clawrouter"],
                pluginSdkResolution: "src",
                preferBuiltPluginArtifacts: false,
                cache: false,
              });
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
                const outcome = await evaluateDecisionV2InRegistry(
                  batch,
                  decisionOptions({ agentId: "main" }),
                  registry,
                  config,
                );
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
                      route: {
                        type: "choice",
                        choice: "support",
                        confidence: 0.8,
                        probabilities: { sales: 0.2, support: 0.8 },
                      },
                      urgency: {
                        type: "score",
                        score: 0.75,
                        confidence: 0.7,
                        probabilities: [0.25, 0.75],
                      },
                      withheld: { type: "error", code: "provider-error", providerCode: "refusal" },
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
                      {
                        name: "route",
                        type: "choice",
                        instructions: "",
                        choices: [
                          { value: "support", description: "Damage" },
                          { value: "sales", description: "Orders" },
                        ],
                      },
                      {
                        name: "urgency",
                        type: "score",
                        instructions: "",
                        levels: [
                          { label: "0", description: "Routine" },
                          { label: "1", description: "Urgent" },
                        ],
                      },
                      { name: "withheld", type: "predicate", instructions: "" },
                    ],
                  },
                });
                expect(inspectDecisionProviders(config, registry)).toContainEqual(
                  expect.objectContaining({ providerId: "clawrouter", activeRequests: 0 }),
                );
                const beforeDisabled = requests.length;
                expect(
                  await evaluateDecisionV2InRegistry(
                    batch,
                    decisionOptions({ agentId: "quiet" }),
                    registry,
                    config,
                  ),
                ).toMatchObject({ status: "unavailable", reason: "disabled" });
                expect(requests).toHaveLength(beforeDisabled);
                if (selector === "default") {
                  holdInference = true;
                  const controller = new AbortController();
                  const pending = evaluateDecisionV2InRegistry(
                    batch,
                    { ...decisionOptions({ agentId: "main" }), signal: controller.signal },
                    registry,
                    config,
                  );
                  await Promise.race([inferenceReceived.promise, pending]);
                  const aborted = expect(pending).rejects.toThrow("fixture caller stopped");
                  controller.abort(new Error("fixture caller stopped"));
                  await aborted;
                  await inferenceClosed.promise;
                  expect(inspectDecisionProviders(config, registry)).toContainEqual(
                    expect.objectContaining({ providerId: "clawrouter", activeRequests: 0 }),
                  );
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
      );
    } finally {
      await state.cleanup();
    }
  },
);
