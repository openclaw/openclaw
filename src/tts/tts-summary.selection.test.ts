import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { providerResponse } from "../agents/embedded-agent-runner.wire.test-support.js";
import { requireApiKey } from "../agents/model-auth.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { acquireAgentRunPreparedModelRuntime } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModelWithSelection,
  completeWithPreparedSimpleCompletionModel,
} from "../agents/simple-completion-runtime.js";
import {
  completionChunk,
  completionModel,
  completionModelDefinition,
} from "../agents/simple-completion.test-support.js";
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
        response.end(completionChunk(`materialized:${model}`, model));
      });
    });
    const baseUrl = `${await listenLoopback(server)}/v1`;
    try {
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
      ].map((id) =>
        completionModel({
          id,
          provider: modelProvider,
          api: "openai-completions",
          baseUrl,
          contextWindow: 16_000,
          maxTokens: 4_096,
        }),
      );
      await state.writeJson("provider/openclaw.plugin.json", {
        id: pluginId,
        providers: [modelProvider],
        modelSupport: { modelPrefixes: ["entry", "fast"] },
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        modelIdNormalization: !options.runtimeHook
          ? {
              providers: { [modelProvider]: { aliases: { entry: "middle", middle: "final" } } },
            }
          : undefined,
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
                ? models
                    .filter(({ id }) => id === options.literalRow)
                    .map(({ id, name }) =>
                      completionModelDefinition({
                        id,
                        name,
                        api: "openai-completions",
                        contextWindow: 16_000,
                        maxTokens: 4_096,
                      }),
                    )
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
      await closeHttpServer(server);
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
it.each([
  { name: "canonical default", model: "kimi-for-coding" },
  { name: "canonical K3 default", model: "k3" },
  { name: "explicit summary override", model: "k3", override: true },
  {
    name: "disabled plugin",
    model: "k3",
    plugins: { entries: { kimi: { enabled: false } } },
    rejected: true,
  },
  { name: "disabled plugins", model: "k3", plugins: { enabled: false }, rejected: true },
  { name: "denied plugin", model: "k3", plugins: { deny: ["kimi"] }, rejected: true },
  { name: "omitted allowlist owner", model: "k3", plugins: { allow: ["google"] }, rejected: true },
  { name: "unknown model", model: "not-a-real-kimi-model", rejected: true },
] satisfies Array<{
  name: string;
  model: string;
  override?: boolean;
  plugins?: OpenClawConfig["plugins"];
  rejected?: boolean;
}>)(
  "respects the cold summary catalog for $name",
  async ({ model: expectedModel, override, plugins, rejected }) => {
    await withOpenClawTestState(
      {
        label: "tts-cold-static-catalog",
        env: {
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          KIMI_API_KEY: undefined,
          KIMICODE_API_KEY: undefined,
        },
      },
      async (state) => {
        const requests: string[] = [];
        const server = createServer((request, response) => {
          void readRequestText(request)
            .then(async (body) => {
              const { model } = JSON.parse(body) as { model: string };
              requests.push(model);
              response.writeHead(200, { "content-type": "text/event-stream" });
              const reply = providerResponse({
                api: "anthropic-messages",
                model,
                id: "kimi-summary",
                messageId: "kimi-summary",
                text: `Summary from ${model}.`,
                calls: [],
              }).response;
              response.end(await reply.text());
            })
            .catch((error: unknown) => {
              response.destroy(error instanceof Error ? error : new Error(String(error)));
            });
        });
        const baseUrl = await listenLoopback(server);
        try {
          const nativeFetch = globalThis.fetch;
          vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
            const request = new Request(input, init);
            expect(request.url).toBe("https://api.kimi.com/coding/v1/messages");
            return nativeFetch(`${baseUrl}/v1/messages`, {
              method: request.method,
              headers: request.headers,
              body: await request.arrayBuffer(),
              signal: request.signal,
            });
          });
          const cfg: OpenClawConfig = {
            agents: {
              defaults: {
                workspace: state.workspaceDir,
                model: `kimi/${override ? "kimi-for-coding" : expectedModel}`,
              },
              entries: { main: {} },
            },
            plugins: {
              allow: ["kimi"],
              entries: { kimi: { enabled: true } },
              slots: { memory: "none" },
              ...plugins,
            },
            ...(override ? { tts: { summaryModel: `kimi/${expectedModel}` } } : {}),
          };
          await state.writeConfig(cfg);
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "kimi:summary-test": { type: "api_key", provider: "kimi", key: "synthetic-kimi-key" },
            },
          });

          // No configured base URL: a generic fallback cannot hide a missing catalog alias.
          const pending = summarizeText({
            cfg,
            config: resolveTtsConfig(cfg),
            text: "Synthetic text for an ordinary TTS summary.",
            targetLength: 100,
            timeoutMs: 10_000,
          });
          if (rejected) {
            await expect(pending).rejects.toThrow(`Unknown model: kimi/${expectedModel}`);
            expect(requests).toEqual([]);
            return;
          }
          expect((await pending).summary).toBe(`Summary from ${expectedModel}.`);
          expect(requests).toEqual([expectedModel]);
          expect(resolveDefaultModelForAgent({ cfg, allowPluginNormalization: false })).toEqual({
            provider: "kimi",
            model: override ? "kimi-for-coding" : expectedModel,
          });
        } finally {
          await closeHttpServer(server);
        }
      },
    );
  },
);
