import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import {
  resetDecisionTestRuntime,
  activateDecisionRegistry,
  decisionOptions,
} from "../agents/decision-inference.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  refreshPreparedModelRuntimeCatalog,
} from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listDecisionModels } from "../gateway/server-methods/models-list-capabilities.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDecisionProviderReload } from "./provider-reload.js";
import { evaluateDecisionV2InRegistry } from "./runtime.js";
import type { DecisionBatchV2 } from "./types-v2.js";

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "How do I reset the router?" },
  questions: {
    page: { type: "boolean", instructions: "Router reset steps" },
    topic: { type: "choice", criteria: { network: "Networking help", billing: null } },
  },
};

function rerankConfig(root: string, origin: string, apiKey?: string) {
  return {
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        decisionModel: "rerank/bge-reranker-v2-m3",
      },
    },
    models: {
      providers: {
        rerank: {
          baseUrl: origin + "/v1",
          ...(apiKey ? { apiKey } : {}),
          // The row authors no inference block; the plugin declares Decision facts.
          models: [
            {
              id: "bge-reranker-v2-m3",
              name: "BGE reranker v2 m3",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              maxTokens: 1,
            },
          ],
        },
      },
    },
    plugins: { allow: ["rerank"], slots: { memory: "none" } },
  } satisfies OpenClawConfig;
}

afterEach(() => resetDecisionTestRuntime());

type Recorded = { path?: string; auth?: string; body: Record<string, unknown> };
type Run = Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>>;

/** A /rerank fixture server behind the real bundled plugin, prepared model runtime and registry. */
async function withRerank(
  field: "documents" | "texts",
  apiKey: string | undefined,
  onRequest: (requests: Recorded[]) => void,
  body: (ctx: {
    config: OpenClawConfig;
    registry: Awaited<ReturnType<typeof activateDecisionRegistry>>;
    run: Run;
    requests: Recorded[];
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    {
      env: {
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        RERANK_API_KEY: undefined,
        HTTP_PROXY: undefined,
        HTTPS_PROXY: undefined,
        ALL_PROXY: undefined,
        http_proxy: undefined,
        https_proxy: undefined,
        all_proxy: undefined,
      },
    },
    async (state) => {
      const requests: Recorded[] = [];
      await withServer(
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
            requests.push({ path: request.url, auth: request.headers.authorization, body });
            onRequest(requests);
            const documents = body[field];
            if (!Array.isArray(documents)) {
              response.writeHead(422).end();
              return;
            }
            const scores = documents.map((_, index) => [0.91, 0.62, 0.08][index] ?? 0);
            response.setHeader("content-type", "application/json");
            response.end(
              JSON.stringify(
                field === "texts"
                  ? scores.map((score, index) => ({ index, score })).toReversed()
                  : {
                      results: scores
                        .map((relevance_score, index) => ({ index, relevance_score }))
                        .toReversed(),
                    },
              ),
            );
          });
        },
        async (origin) => {
          const config = rerankConfig(state.root, origin, apiKey);
          const registry = await activateDecisionRegistry(config, {
            onlyPluginIds: ["rerank"],
            pluginSdkResolution: "src",
            preferBuiltPluginArtifacts: false,
            cache: false,
          });
          try {
            await using run = await acquireAgentRunPreparedModelRuntime(
              {
                config,
                agentId: "main",
                agentDir: resolveAgentDir(config, "main"),
                workspaceDir: config.agents.defaults.workspace,
                loadRuntimePlugins: true,
                runtimePluginSelections: [
                  { provider: "rerank", modelId: "bge-reranker-v2-m3", agentId: "main" },
                ],
              },
              { catalogMode: "static" },
            );
            await body({ config, registry, run, requests });
          } finally {
            prepareDecisionProviderReload(registry, new Set(["rerank"]));
            for (const record of registry.plugins) {
              await getPluginInstance(record)?.dispose();
            }
          }
        },
      );
    },
  );
}

it.each([
  ["a keyless Cohere-style", undefined, "documents"],
  ["a keyed Cohere-style", "synthetic-rerank-key", "documents"],
  ["a TEI-style", undefined, "texts"],
] as const)(
  "answers Boolean and Choice questions through %s /rerank server",
  async (_label, apiKey, field) =>
    withRerank(
      field,
      apiKey,
      () => {},
      async ({ config, registry, run, requests }) => {
        const outcome = await evaluateDecisionV2InRegistry(
          batch,
          decisionOptions({ agentId: "main" }),
          registry,
          config,
        );
        expect(outcome).toMatchObject({
          status: "ok",
          result: {
            model: "bge-reranker-v2-m3",
            answers: {
              page: { type: "boolean", probabilityTrue: 0.91 },
              topic: {
                type: "choice",
                choice: "network",
                probabilities: { network: 0.62, billing: 0.08 },
              },
            },
          },
          provenance: { providerId: "rerank" },
        });
        // The live catalog the Decision picker reads lists the configured row.
        const catalog = await refreshPreparedModelRuntimeCatalog(run.snapshot);
        expect(
          listDecisionModels({
            config,
            snapshot: run.snapshot.metadataSnapshot,
            catalog: catalog!.entries,
          }),
        ).toContainEqual(
          expect.objectContaining({
            provider: "rerank",
            id: "bge-reranker-v2-m3",
            pluginId: "rerank",
          }),
        );
        expect(requests.at(-1)).toEqual({
          path: "/v1/rerank",
          auth: apiKey ? `Bearer ${apiKey}` : undefined,
          body: {
            model: "bge-reranker-v2-m3",
            query: "How do I reset the router?",
            [field]: ["Router reset steps", "Networking help", "billing"],
          },
        });
        // TEI rejects the Cohere field once, then the endpoint is remembered.
        expect(requests).toHaveLength(field === "texts" ? 2 : 1);
      },
    ),
);

// A caller grant revoked mid-request must stop egress, not only publication.
it.each([
  ["during preparation", 2, 0],
  ["between the first request and its retry", Infinity, 1],
] as const)(
  "sends nothing more once caller authority is revoked %s",
  async (_label, okCalls, sent) => {
    let revoked = false;
    let calls = 0;
    const assertCurrent = () => {
      calls += 1;
      if (revoked || calls > okCalls) {
        revoked = true;
        throw new Error("Knowledge grant revoked");
      }
    };
    await withRerank(
      "texts",
      undefined,
      () => {
        revoked = true;
      },
      async ({ config, registry, requests }) => {
        await expect(
          evaluateDecisionV2InRegistry(
            batch,
            { ...decisionOptions({ agentId: "main" }), assertCurrent },
            registry,
            config,
          ),
        ).rejects.toThrow("Knowledge grant revoked");
        expect(requests).toHaveLength(sent);
      },
    );
  },
);
