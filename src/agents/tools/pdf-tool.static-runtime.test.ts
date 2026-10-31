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

it.each(["alias", "inline"])(
  "resolves the captured %s model through PDF execution",
  async (source) => {
    const alias = source === "alias";
    await withOpenClawTestState(
      {
        label: "pdf-static-model",
        env: {
          OPENAI_API_KEY: "test-key",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: alias ? "1" : undefined,
        },
      },
      async (state) => {
        const provider = alias ? "pdf-captured-model" : "openai";
        const modelId = alias ? "middle" : "gpt-5.6-luna";
        const api = alias ? "openai-completions" : "openai-responses";
        const baseUrl = "http://127.0.0.1:9/v1";
        const input: "text"[] = ["text"];
        const makeModel = (id: string) => ({
          id,
          name: id,
          reasoning: !alias,
          input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: alias ? 16_000 : 128_000,
          maxTokens: alias ? 4096 : 8192,
        });
        const pluginDir = path.join(state.root, "provider");
        if (alias) {
          await fs.mkdir(pluginDir);
          await fs.writeFile(
            path.join(pluginDir, "openclaw.plugin.json"),
            JSON.stringify({
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
            }),
          );
          await fs.writeFile(
            path.join(pluginDir, "index.cjs"),
            `module.exports = { id: ${JSON.stringify(provider)}, register(api) { api.registerProvider({ id: ${JSON.stringify(provider)}, label: "PDF alias fixture", auth: [] }); } };`,
          );
        }
        const modelRef = `${provider}/${alias ? "entry" : modelId}`;
        await state.writeConfig({
          agents: {
            entries: { main: {} },
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: modelRef },
              pdfModel: { primary: modelRef },
            },
          },
          models: {
            ...(!alias ? { mode: "replace" } : {}),
            providers: {
              [provider]: {
                baseUrl,
                apiKey: "synthetic-fixture",
                models: alias ? [] : [makeModel(modelId)],
                ...(!alias ? { api: "openai-responses" } : {}),
              },
            },
          },
          ...(alias
            ? {
                plugins: {
                  allow: [provider],
                  entries: { [provider]: { enabled: true } },
                  load: { paths: [path.join(pluginDir, "index.cjs")] },
                  slots: { memory: "none" },
                },
              }
            : {}),
        });
        const config = loadConfig({
          pin: false,
          skipPluginValidation: true,
          skipShellEnvFallback: true,
        });
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        const lease = await acquireAgentRunPreparedModelRuntime(
          { agentDir, config, workspaceDir: state.workspaceDir },
          { catalogMode: "static" },
        );
        try {
          vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue(FAKE_PDF_MEDIA);
          vi.spyOn(pdfExtract, "extractPdfContent").mockResolvedValue({
            text: "Captured model fixture",
            images: [],
          });
          completeMock.mockResolvedValue({
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "selected model" }],
          });
          const tool = createPdfTool({
            config,
            agentDir,
            workspaceDir: state.workspaceDir,
            preparedModelRuntime: lease.snapshot,
          });
          if (!tool) {
            throw new Error("expected PDF tool");
          }
          const result = await tool.execute("pdf-static", {
            prompt: "Summarize",
            pdf: path.join(state.workspaceDir, "fixture.pdf"),
          });
          expect(completeMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ provider, id: modelId, baseUrl }),
            expect.any(Object),
            expect.any(Object),
            expect.any(Function),
          );
          expect(result.details).toMatchObject({ model: `${provider}/${modelId}`, native: false });
        } finally {
          await lease[Symbol.asyncDispose]();
        }
      },
    );
  },
);
