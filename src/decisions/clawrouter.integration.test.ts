import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  resetDecisionTestRuntime,
  activateDecisionRegistry,
  decisionOptions,
} from "../agents/decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { createDecisionTool } from "../agents/tools/decision-tool.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDecisionModels } from "../gateway/server-methods/models-list-capabilities.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDecisionProviderReload } from "./provider-reload.js";
import { evaluateDecisionV2InRegistry } from "./runtime.js";
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
            const evaluate = (agentId = "main") =>
              evaluateDecisionV2InRegistry(batch, decisionOptions({ agentId }), registry, config);
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
              const outcome = await evaluate();
              expect(
                listDecisionModels({
                  config,
                  snapshot: prepared.snapshot.metadataSnapshot,
                  catalog: prepared.snapshot.modelCatalog.entries,
                }),
              ).toContainEqual(
                expect.objectContaining({
                  provider: "clawrouter",
                  id: "openai/gpt-6-luna",
                  pluginId: "clawrouter",
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
              expect(
                registry.decisionProviders.map((entry) => entry.host.inspect(config)),
              ).toContainEqual(
                expect.objectContaining({ providerId: "clawrouter", activeRequests: 0 }),
              );
              const beforeDisabled = requests.length;
              expect(await evaluate("quiet")).toMatchObject({
                status: "unavailable",
                reason: "disabled",
              });
              expect(requests).toHaveLength(beforeDisabled);
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

const basetenModels = [
  "decision-models/baseten-elephant-9b-latest",
  "decision-models/baseten-mammoth-27b-latest",
  "decision-models/baseten-joey-2b-latest",
];
const basetenDecision = {
  protocol: "baseten-systemone",
  questions: {
    boolean: { probabilities: "boolean", abstention: false },
    choice: {
      probabilities: "provider-defined",
      abstention: false,
      minOptions: 2,
      maxOptions: 255,
    },
    score: { probabilities: "provider-defined", abstention: false, minOptions: 2, maxOptions: 10 },
  },
  reasoning: { modes: ["auto"] },
  confidence: "provider-specific",
  outputTokensPerQuestion: 1,
  limits: { maxTotalOptions: 512, maxStateAndQuestionTokens: 16384 },
};
const basetenBatch: DecisionBatchV2 = {
  state: { type: "json", value: { parcel: "synthetic damaged parcel" } },
  questions: {
    damaged: {
      type: "boolean",
      instructions: "Inspect",
      criteria: { true: { damaged: true }, false: "Intact" },
    },
    route: { type: "choice", criteria: { support: { team: "support" }, billing: "Billing" } },
    severity: { type: "score", criteria: ["Low", { level: "Medium" }, "High"] },
  },
};
const basetenResult = {
  model: "synthetic-served-backend",
  answers: {
    damaged: { type: "noul", noul: 0.9 },
    route: {
      type: "choice",
      choice: "support",
      probabilities: { support: 0.8, billing: 0.2 },
      confidence: 0.2,
    },
    severity: {
      type: "score",
      score: 1.25,
      probabilities: { "0": 0.2, "1": 0.35, "2": 0.45 },
      confidence: 0.3,
      legend: { "0": "Low", "1": '{"level":"Medium"}', "2": "High" },
    },
  },
  usage: { input_tokens: 11, output_tokens: 3 },
};
function basetenCatalog(routeKind: "native" | "manifest") {
  return {
    version: "clawrouter.client-catalog.v1",
    observedAt: new Date().toISOString(),
    scope: { authType: "proxy_key", credentialId: "synthetic-proxy-owner" },
    providers: [
      {
        id: "baseten",
        allowed: true,
        executable: true,
        nativeBaseUrl: "/v1/native/baseten",
        routes: [
          {
            endpoint: "systemone",
            path: "/systemone",
            methods: ["POST"],
            requestFormat: "baseten.systemone",
            responseFormat: "baseten.systemone",
          },
        ],
        models: basetenModels.map((upstream) => ({
          id: `baseten/${upstream}`,
          upstream,
          capabilities: ["llm.decisions"],
          nativeCapabilities: {
            version: "clawrouter.native-capabilities.v1",
            endpoints: {
              systemone: {
                input: ["text", "json"],
                inference: { chat: false, decision: structuredClone(basetenDecision) },
              },
            },
          },
        })),
        offers: basetenModels.map((upstream) => ({
          modelId: `baseten/${upstream}`,
          endpoint: "systemone",
          transport: "http",
          routeKind,
          route:
            routeKind === "native" ? "/v1/native/baseten/systemone" : "/v1/proxy/baseten/systemone",
          eligible: true,
          affordability: "request-dependent",
        })),
      },
    ],
  };
}

it.each(["native", "manifest"] as const)(
  "runs catalog-scoped Baseten %s through the actual decision_evaluate consumer",
  async (routeKind) =>
    withOpenClawTestState(
      {
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          BASETEN_API_KEY: "synthetic-vendor-key-must-not-be-used",
          CLAWROUTER_API_KEY: undefined,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          ALL_PROXY: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
          all_proxy: undefined,
        },
      },
      async (state) => {
        let offered = basetenCatalog(routeKind);
        let output: unknown = basetenResult;
        const catalogAuth: Array<string | undefined> = [];
        const requests: Array<{
          path?: string;
          auth?: string;
          vendorKey?: string;
          body: Record<string, unknown>;
        }> = [];
        await withServer(
          (request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
              response.setHeader("content-type", "application/json");
              if (request.url === "/v1/catalog") {
                catalogAuth.push(request.headers.authorization);
                response.end(JSON.stringify(offered));
              } else {
                requests.push({
                  path: request.url,
                  auth: request.headers.authorization,
                  vendorKey: request.headers["x-api-key"] as string | undefined,
                  body: JSON.parse(Buffer.concat(chunks).toString()),
                });
                response.end(JSON.stringify(output));
              }
            });
          },
          async (origin) => {
            const config = routerConfig(origin, state.root, "default");
            config.agents.defaults.decisionModel = `clawrouter/baseten/${basetenModels[0]}`;
            config.models.providers.clawrouter.models = [];
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
                    {
                      provider: "clawrouter",
                      modelId: `baseten/${basetenModels[0]}`,
                      agentId: "main",
                    },
                  ],
                },
                { catalogMode: "static" },
              );
              const rows = prepared.snapshot.modelCatalog.entries.filter(
                (row) => row.provider === "clawrouter" && row.id.startsWith("baseten/"),
              );
              expect(rows.map((row) => row.id).sort()).toEqual(
                basetenModels.map((id) => `baseten/${id}`).sort(),
              );
              for (const row of rows) {
                expect(row.api).toBeUndefined();
                expect(row.inference).toMatchObject({ chat: false, decision: basetenDecision });
                expect(row.inference?.decision?.billing).toBeUndefined();
                expect(row.contextWindow).toBeUndefined();
              }
              const tool = createDecisionTool("main", {
                config,
                preparedModelRuntime: prepared.snapshot,
              })!;
              expect(tool.name).toBe("decision_evaluate");
              expect(tool.description).toContain("512 total options");
              const execute = (input: DecisionBatchV2 = basetenBatch) =>
                tool.execute("synthetic-baseten", { contractVersion: 2, ...input });
              expect(await execute()).toMatchObject({
                details: {
                  status: "ok",
                  result: {
                    model: "synthetic-served-backend",
                    answers: {
                      damaged: { probabilityTrue: 0.9 },
                      route: { confidence: 0.2 },
                      severity: { score: 1.25 },
                    },
                    usage: { inputTokens: 11, outputTokens: 3 },
                  },
                  provenance: { providerId: "clawrouter" },
                },
              });
              const wire = {
                model: basetenModels[0],
                state: '{"parcel":"synthetic damaged parcel"}',
                questions: {
                  damaged: {
                    type: "noul",
                    instructions:
                      'Inspect\nTrue criterion: {"damaged":true}\nFalse criterion: Intact',
                  },
                  route: {
                    type: "choice",
                    instructions: "",
                    criteria: { support: '{"team":"support"}', billing: "Billing" },
                  },
                  severity: {
                    type: "score",
                    instructions: "",
                    criteria: ["Low", '{"level":"Medium"}', "High"],
                  },
                },
              };
              expect(requests).toEqual([
                {
                  path:
                    routeKind === "native"
                      ? "/v1/native/baseten/systemone"
                      : "/v1/proxy/baseten/systemone",
                  auth: "Bearer synthetic-router-only",
                  vendorKey: undefined,
                  body: routeKind === "native" ? wire : { body: wire },
                },
              ]);
              const criteria = Object.fromEntries(
                Array.from({ length: 255 }, (_, i) => [String(i), "Synthetic"]),
              );
              const choiceAnswer = {
                type: "choice",
                choice: "0",
                confidence: 0.1,
                probabilities: Object.fromEntries(Object.keys(criteria).map((id) => [id, 1 / 255])),
              };
              output = {
                model: "synthetic-served-backend",
                usage: { input_tokens: 11, output_tokens: 3 },
                answers: {
                  first: choiceAnswer,
                  second: choiceAnswer,
                  last: { type: "noul", noul: 0.5 },
                },
              };
              expect(
                await execute({
                  state: { type: "text", text: "Synthetic" },
                  questions: {
                    first: { type: "choice", criteria },
                    second: { type: "choice", criteria },
                    last: { type: "boolean" },
                  },
                }),
              ).toMatchObject({ details: { status: "ok" } });
              output = basetenResult;
              const count = requests.length;
              expect(
                await execute({
                  state: { type: "text", text: "Synthetic" },
                  questions: {
                    first: { type: "choice", criteria },
                    second: { type: "choice", criteria },
                    last: { type: "score", criteria: ["Low", "Medium", "High"] },
                  },
                }),
              ).toMatchObject({ details: { status: "unavailable", reason: "unsupported-input" } });
              expect(requests).toHaveLength(count);
              for (const mutate of [
                () => {
                  offered.providers[0]!.offers[0]!.eligible = false;
                },
                () => {
                  offered.providers[0]!.offers[0]!.route = "https://foreign.invalid/systemone";
                },
                () => {
                  offered.providers[0]!.routes[0]!.requestFormat = "liquid.systemone";
                },
                () => {
                  offered.providers[0]!.models[0]!.upstream = "unqualified-model";
                },
                () => {
                  offered.observedAt = "2000-01-01T00:00:00Z";
                },
                () => {
                  offered.scope.authType = "upstream_key";
                },
              ]) {
                offered = basetenCatalog(routeKind);
                mutate();
                expect(await execute()).toMatchObject({ details: { status: "unavailable" } });
                expect(requests).toHaveLength(count);
              }
              offered = basetenCatalog(routeKind);
              for (const usage of [undefined, { input_tokens: 11, output_tokens: 2 }]) {
                output = { ...basetenResult, usage };
                expect(await execute()).toMatchObject({
                  details: { status: "unavailable", reason: "invalid-response" },
                });
              }
              output = { ...basetenResult, model: "synthetic-router-only" };
              const reflected = await execute();
              expect(reflected).toMatchObject({
                details: { status: "unavailable", reason: "invalid-response" },
              });
              expect(JSON.stringify(reflected)).not.toContain("synthetic-router-only");
              expect(catalogAuth.length).toBeGreaterThan(1);
              expect(new Set(catalogAuth)).toEqual(new Set(["Bearer synthetic-router-only"]));
              const beforeMissingKey = requests.length;
              setRuntimeConfigSnapshot({
                ...config,
                models: {
                  providers: {
                    clawrouter: {
                      ...config.models.providers.clawrouter,
                      apiKey: undefined,
                    },
                  },
                },
              });
              expect(await execute()).toMatchObject({
                details: { status: "unavailable", reason: "credentials-unavailable" },
              });
              expect(requests).toHaveLength(beforeMissingKey);
            } finally {
              prepareDecisionProviderReload(registry, new Set(["clawrouter"]));
              for (const record of registry.plugins) await getPluginInstance(record)?.dispose();
            }
          },
        );
      },
    ),
);
