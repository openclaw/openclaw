// Shared /rerank fixture: a local HTTP server behind the real bundled rerank
// plugin, prepared model runtime and Decision registry.
import path from "node:path";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { activateDecisionRegistry } from "../agents/decision-inference.test-support.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareDecisionProviderReload } from "./provider-reload.js";

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

type Recorded = { path?: string; auth?: string; body: Record<string, unknown> };
type Run = Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>>;

/** A /rerank fixture server behind the real bundled plugin, prepared model runtime and registry. */
export async function withRerank(
  field: "documents" | "texts",
  apiKey: string | undefined,
  onRequest: (requests: Recorded[]) => void,
  use: (ctx: {
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
            await use({ config, registry, run, requests });
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
