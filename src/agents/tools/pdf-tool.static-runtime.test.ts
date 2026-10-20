import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "../../config/config.js";
import * as pdfExtract from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";
import { createPdfTool } from "./pdf-tool.js";
import { FAKE_PDF_MEDIA } from "./pdf-tool.test-support.js";

const completeMock = vi.hoisted(() => vi.fn());
vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, completeSimple: completeMock };
});
afterEach(() => {
  completeMock.mockReset();
  vi.restoreAllMocks();
});

it.each(["alias", "inline"])("resolves captured %s PDF models", async (source) => {
  const alias = source === "alias";
  await withOpenClawTestState(
    {
      env: {
        OPENAI_API_KEY: "test-key",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: alias ? "1" : undefined,
      },
    },
    async (state) => {
      const { workspaceDir } = state;
      const provider = alias ? "pdf-captured-model" : "openai";
      const modelId = alias ? "middle" : "gpt-5.6-luna";
      const api = alias ? "openai-completions" : "openai-responses";
      const baseUrl = "http://127.0.0.1:9/v1";
      const makeModel = (id: string) => ({ id, name: id, input: ["text"] });
      const pluginDir = path.join(state.stateDir, "provider");
      if (alias) {
        await state.writeJson("provider/openclaw.plugin.json", {
          id: provider,
          providers: [provider],
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          modelIdNormalization: {
            providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
          },
          modelCatalog: {
            discovery: { [provider]: "static" },
            providers: {
              [provider]: {
                api,
                baseUrl,
                models: ["middle", "final"].map((id) => Object.assign(makeModel(id), { api })),
              },
            },
          },
        });
        await state.writeText(
          "provider/index.cjs",
          `module.exports = { id: ${JSON.stringify(provider)}, register(api) { api.registerProvider({ id: ${JSON.stringify(provider)}, label: "PDF alias fixture", auth: [] }); } };`,
        );
      }
      const model = { primary: `${provider}/${alias ? "entry" : modelId}` };
      await state.writeConfig({
        agents: { defaults: { workspace: workspaceDir, model, pdfModel: model } },
        models: {
          mode: alias ? undefined : "replace",
          providers: {
            [provider]: {
              baseUrl,
              apiKey: "synthetic-fixture",
              models: alias ? [] : [makeModel(modelId)],
              api: alias ? undefined : "openai-responses",
            },
          },
        },
        plugins: alias
          ? {
              allow: [provider],
              entries: { [provider]: { enabled: true } },
              load: { paths: [path.join(pluginDir, "index.cjs")] },
              slots: { memory: "none" },
            }
          : undefined,
      });
      const config = loadConfig({
        pin: false,
        skipPluginValidation: true,
        skipShellEnvFallback: true,
      });
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      const runtimeOptions = { agentDir, config, workspaceDir };
      await using lease = await acquireAgentRunPreparedModelRuntime(runtimeOptions, {
        catalogMode: "static",
      });
      vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
      vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({ text: "PDF", images: [] });
      completeMock.mockResolvedValue({
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "selected model" }],
      });
      const tool =
        createPdfTool({
          ...runtimeOptions,
          preparedModelRuntime: lease.snapshot,
        }) ?? expect.fail("expected PDF tool");
      const result = await tool.execute("pdf-static", {
        prompt: "Summarize",
        pdf: path.join(workspaceDir, "fixture.pdf"),
      });
      expect(completeMock).toHaveBeenCalledOnce();
      expect(completeMock.mock.calls[0]?.[0]).toMatchObject({ provider, id: modelId, baseUrl });
      expect(result.details).toMatchObject({ model: `${provider}/${modelId}`, native: false });
    },
  );
});
