import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireApiKey } from "../agents/model-auth.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModel,
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

describe.each([undefined, "openai-completions"] as const)(
  "unscoped summary selection with provider API %s",
  (api) => {
    it.each([
      { name: "explicit override", summaryModel: `${provider}/entry`, expected: "middle" },
      { name: "global bare alias", summaryModel: "fast", expected: "middle" },
      { name: "global qualified alias", summaryModel: `${provider}/fast`, expected: "middle" },
      { name: "bare literal", summaryModel: "entry", expected: "middle" },
      { name: "missing override", primary: `${provider}/entry`, expected: "middle" },
      { name: "bare global default", primary: "fast", expected: "middle" },
      { name: "invalid override", summaryModel: "/", primary: "fast", expected: "middle" },
      { name: "profile suffix", summaryModel: "fast@work", expected: "middle" },
      { name: "raw next alias", summaryModel: `${provider}/middle`, expected: "final" },
      { name: "ordinary model", summaryModel: `${provider}/plain`, expected: "plain" },
    ])("uses the global model for $name", async ({ expected, ...options }) => {
      await withSummaryFixture({ ...options, api }, async (cfg, _state, requests) => {
        expect(await summarizeText(summaryRequest(cfg))).toMatchObject({
          summary: `materialized:${expected}`,
        });
        expect(requests).toEqual([expected]);
      });
    });

    it.each([
      { name: "missing override", primary: "entry", expected: "middle" },
      { name: "invalid override", primary: "entry", summaryModel: "/", expected: "middle" },
      {
        name: "explicit bare override",
        primary: "plain",
        summaryModel: "entry",
        expected: "middle",
      },
      {
        name: "qualified primary",
        primary: "openai/entry",
        expected: "middle",
      },
      { name: "raw next alias", primary: "middle", expected: "final" },
      { name: "ordinary primary", primary: "plain", expected: "plain" },
    ])(
      "uses the default provider without configured rows for $name",
      async ({ expected, ...options }) => {
        await withSummaryFixture(
          { ...options, api, bareDefault: true },
          async (cfg, _state, requests) => {
            expect(cfg.agents?.defaults?.models).toEqual({});
            expect(cfg.agents?.entries?.main?.models).toEqual({});
            expect(cfg.models?.providers?.openai?.models).toEqual([]);
            expect(await summarizeText(summaryRequest(cfg))).toMatchObject({
              summary: `materialized:${expected}`,
            });
            expect(requests).toEqual([expected]);
          },
        );
      },
    );
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
      const prepared = await acquireSimpleCompletionModel({ cfg, provider, modelId: "plain" });
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
