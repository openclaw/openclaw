import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { requireApiKey } from "../agents/model-auth.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModelWithSelection,
  completeWithPreparedSimpleCompletionModel,
} from "../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { summarizeText } from "../plugin-sdk/speech-core.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveTtsConfig } from "./tts-settings.js";

const provider = "tts-selected";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  vi.restoreAllMocks();
});

type FixtureOptions = {
  api?: "openai-completions";
  summaryModel?: string;
  primary?: string;
  literalRow?: string;
  runtimeHook?: boolean;
  bareDefault?: boolean;
};

async function withSummaryFixture(
  options: FixtureOptions,
  run: (cfg: OpenClawConfig, state: OpenClawTestState, requests: string[]) => Promise<void>,
) {
  const modelProvider = options.bareDefault ? "openai" : provider;
  const pluginId = modelProvider;
  await withOpenClawTestState({ label: "tts-summary-selection" }, async (state) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        const { model } = JSON.parse(body) as { model: string };
        requests.push(model);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "tts-selection-response",
            object: "chat.completion.chunk",
            model,
            choices: [
              { index: 0, delta: { content: `materialized:${model}` }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Summary fixture did not expose a TCP port");
      }
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const nativeFetch = globalThis.fetch;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        expect(url.origin).toBe(new URL(baseUrl).origin);
        return nativeFetch(input, init);
      });
      const models = [
        "entry",
        "middle",
        "final",
        "plain",
        "agent-model",
        "runtime-drift",
        `${modelProvider}/entry`,
      ].map((id) => ({
        id,
        name: id,
        provider: modelProvider,
        api: "openai-completions" as const,
        baseUrl,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_000,
        maxTokens: 4_096,
      }));
      await state.writeJson("provider/openclaw.plugin.json", {
        id: pluginId,
        providers: [modelProvider],
        modelSupport: { modelPrefixes: ["entry", "fast"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        ...(!options.runtimeHook
          ? {
              modelIdNormalization: {
                providers: { [modelProvider]: { aliases: { entry: "middle", middle: "final" } } },
              },
            }
          : {}),
        modelCatalog: {
          discovery: { [modelProvider]: "static" },
          providers: { [modelProvider]: { api: "openai-completions", baseUrl, models } },
        },
      });
      const runtimePath = await state.writeText(
        "provider/index.cjs",
        `const models = ${JSON.stringify(models)};
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(modelProvider)}, label: "TTS selection", auth: [],
      normalizeModelId({ modelId }) {
        return ${options.runtimeHook === true} && modelId === "entry" ? "runtime-drift" : undefined;
      },
      resolveDynamicModel({ modelId }) { return models.find(model => model.id === modelId); },
    });
  },
};
`,
      );
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: state.workspaceDir,
            model: { primary: options.primary ?? `${modelProvider}/plain` },
            models: options.bareDefault
              ? {}
              : {
                  [`${modelProvider}/entry`]: { alias: "fast" },
                  ...(options.literalRow === `${modelProvider}/entry`
                    ? { [`${modelProvider}/${modelProvider}/entry`]: { alias: "literal" } }
                    : {}),
                },
          },
          entries: {
            main: {
              model: { primary: `${modelProvider}/agent-model` },
              models: options.bareDefault
                ? {}
                : { [`${modelProvider}/agent-model`]: { alias: "fast" } },
            },
          },
        },
        models: {
          providers: {
            [modelProvider]: {
              api: options.api,
              baseUrl,
              apiKey: "synthetic-fixture",
              models: options.literalRow
                ? models.filter(({ id }) => id === options.literalRow)
                : [],
            },
          },
        },
        tts: { summaryModel: options.summaryModel },
        plugins: {
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
          load: { paths: [runtimePath] },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(cfg);
      await run(cfg, state, requests);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
}

function summaryRequest(cfg: OpenClawConfig) {
  return {
    cfg,
    config: resolveTtsConfig(cfg),
    text: "Synthetic summary input.",
    targetLength: 100,
    timeoutMs: 10_000,
  };
}

it.each([
  { name: "explicit override", summaryModel: `${provider}/entry` },
  { name: "qualified alias", summaryModel: `${provider}/fast`, api: "openai-completions" },
  { name: "bare literal", summaryModel: "entry", api: "openai-completions" },
  { name: "missing override", primary: `${provider}/entry` },
  { name: "invalid override", summaryModel: "/", primary: "fast", api: "openai-completions" },
  { name: "bare alias with profile suffix", summaryModel: "fast@work" },
  { name: "bare default without configured rows", primary: "entry", bareDefault: true },
  {
    name: "invalid override without configured rows",
    primary: "entry",
    summaryModel: "/",
    bareDefault: true,
    api: "openai-completions",
  },
  {
    name: "bare override without configured rows",
    primary: "plain",
    summaryModel: "entry",
    bareDefault: true,
  },
] satisfies Array<FixtureOptions & { name: string }>)(
  "normalizes the global summary selection once for $name",
  async (options) => {
    await withSummaryFixture(options, async (cfg, _state, requests) => {
      expect(await summarizeText(summaryRequest(cfg))).toMatchObject({
        summary: "materialized:middle",
      });
      expect(requests).toEqual(["middle"]);
    });
  },
);

it.each(["literal", `${provider}/${provider}/entry`])(
  "preserves an exact configured API-owner model for %s",
  async (summaryModel) => {
    await withSummaryFixture(
      { api: "openai-completions", summaryModel, literalRow: `${provider}/entry` },
      async (cfg, _state, requests) => {
        expect(await summarizeText(summaryRequest(cfg))).toMatchObject({
          summary: `materialized:${provider}/entry`,
        });
        expect(requests).toEqual([`${provider}/entry`]);
      },
    );
  },
);

it("keeps an exact API-owner row unchanged under a real caller's runtime hook", async () => {
  await withSummaryFixture(
    {
      api: "openai-completions",
      summaryModel: `${provider}/entry`,
      literalRow: "entry",
      runtimeHook: true,
    },
    async (cfg, state, requests) => {
      const lease = await acquireAgentRunPreparedModelRuntime(
        {
          config: cfg,
          agentId: "main",
          agentDir: state.agentDir(),
          workspaceDir: state.workspaceDir,
          loadRuntimePlugins: true,
          runtimePluginSelections: [{ provider, modelId: "entry" }],
        },
        { catalogMode: "static" },
      );
      try {
        const result = await withPluginRuntimeGenerationScope(lease.snapshot, () =>
          summarizeText(summaryRequest(cfg)),
        );
        expect(result.summary).toBe("materialized:entry");
        expect(requests).toEqual(["entry"]);
      } finally {
        await lease[Symbol.asyncDispose]();
      }
    },
  );
});

it("retains the shipped injected callback shape and caller-owned returned model", async () => {
  await withSummaryFixture(
    { api: "openai-completions", summaryModel: "fast@work" },
    async (cfg, _state, requests) => {
      const prepared = await acquireSimpleCompletionModelWithSelection({ cfg }, () => ({
        selection: { provider, modelId: "plain" },
      }));
      if ("error" in prepared) {
        throw new Error(prepared.error);
      }
      try {
        const prepare = vi.fn(async () => prepared);
        const result = await summarizeText(summaryRequest(cfg), {
          prepareSimpleCompletionModel: prepare,
          completeWithPreparedSimpleCompletionModel,
          requireApiKey,
        });
        expect(prepare).toHaveBeenCalledExactlyOnceWith({ cfg, provider, modelId: "middle" });
        expect(result.summary).toBe("materialized:plain");
        const reused = await completeWithPreparedSimpleCompletionModel({
          cfg,
          model: prepared.model,
          auth: prepared.auth,
          context: { messages: [{ role: "user", content: "Reuse caller model.", timestamp: 0 }] },
          options: { maxTokens: 64 },
        });
        expect(reused).toMatchObject({ content: [{ type: "text", text: "materialized:plain" }] });
        expect(requests).toEqual(["plain", "plain"]);
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
    },
  );
});
