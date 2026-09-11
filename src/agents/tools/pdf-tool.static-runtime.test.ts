// PDF model resolution must consume configured facts from static prepared runtimes.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config/config.js";
import * as pdfExtractModule from "../../media/pdf-extract.js";
import * as webMedia from "../../media/web-media.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { acquireAgentRunPreparedModelRuntime } from "../prepared-model-runtime.js";

const completeMock = vi.hoisted(() => vi.fn());

vi.mock("../../llm/stream.js", async () => {
  const actual = await vi.importActual<typeof import("../../llm/stream.js")>("../../llm/stream.js");
  return { ...actual, complete: completeMock };
});

vi.mock("../provider-stream.js", () => ({
  registerProviderStreamForModel: vi.fn(),
}));

describe("PDF tool static prepared runtime", () => {
  afterEach(() => {
    completeMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([undefined, "openai-completions"] as const)(
    "selects a captured PDF alias once with provider API %s",
    async (api) => {
      await withOpenClawTestState(
        {
          label: "pdf-static-model-alias",
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const provider = "pdf-captured-model";
          const baseUrl = "http://127.0.0.1:9/v1";
          const pluginDir = path.join(state.root, "provider");
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
                    api: "openai-completions",
                    baseUrl,
                    models: ["middle", "final"].map((id) => ({
                      id,
                      name: id,
                      api: "openai-completions",
                      reasoning: false,
                      input: ["text"],
                      contextWindow: 16_000,
                      maxTokens: 4096,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    })),
                  },
                },
              },
            }),
          );
          await fs.writeFile(
            path.join(pluginDir, "index.cjs"),
            `module.exports = { id: ${JSON.stringify(provider)}, register(api) { api.registerProvider({ id: ${JSON.stringify(provider)}, label: "PDF alias fixture", auth: [] }); } };`,
          );
          await state.writeConfig({
            agents: {
              entries: { main: {} },
              defaults: {
                workspace: state.workspaceDir,
                model: { primary: `${provider}/entry` },
                pdfModel: { primary: `${provider}/entry` },
              },
            },
            models: {
              providers: {
                [provider]: {
                  baseUrl,
                  apiKey: "synthetic-fixture",
                  models: [],
                  ...(api ? { api } : {}),
                },
              },
            },
            plugins: {
              allow: [provider],
              entries: { [provider]: { enabled: true } },
              load: { paths: [path.join(pluginDir, "index.cjs")] },
              slots: { memory: "none" },
            },
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
            vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue({
              kind: "document",
              buffer: Buffer.from("%PDF-1.4 alias fixture"),
              contentType: "application/pdf",
              fileName: "alias.pdf",
            });
            vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
              text: "Captured model fixture",
              images: [],
            });
            completeMock.mockResolvedValue({
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "selected middle" }],
            });
            const { createPdfTool } = await import("./pdf-tool.js");
            const tool = createPdfTool({
              config,
              agentDir,
              workspaceDir: state.workspaceDir,
              preparedModelRuntime: lease.snapshot,
            });
            if (!tool) {
              throw new Error("expected PDF tool");
            }
            const result = await tool.execute("pdf-static-alias", {
              prompt: "Summarize",
              pdf: path.join(state.workspaceDir, "alias.pdf"),
            });
            expect(completeMock).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ provider, id: "middle", api: "openai-completions" }),
              expect.any(Object),
              expect.any(Object),
            );
            expect(result.details).toMatchObject({
              model: `${provider}/middle`,
              native: false,
            });
          } finally {
            lease.release();
          }
        },
      );
    },
  );

  it("resolves a configured model from the static prepared registry", async () => {
    await withOpenClawTestState(
      {
        label: "pdf-static-inline-model",
        env: { OPENAI_API_KEY: "test-key" },
      },
      async (state) => {
        const modelId = "gpt-5.6-luna";
        const modelRef = `openai/${modelId}`;
        await state.writeConfig({
          models: {
            mode: "replace",
            providers: {
              openai: {
                api: "openai-responses",
                baseUrl: "http://127.0.0.1:9/v1",
                models: [
                  {
                    id: modelId,
                    name: "GPT-5.6 Luna inline fixture",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              model: { primary: modelRef },
              pdfModel: { primary: modelRef },
            },
          },
        });
        const config = loadConfig({
          pin: false,
          skipPluginValidation: true,
          skipShellEnvFallback: true,
        });
        const agentDir = state.agentDir();
        await fs.mkdir(agentDir, { recursive: true });
        const lease = await acquireAgentRunPreparedModelRuntime(
          { agentDir, config },
          { catalogMode: "static" },
        );

        try {
          const stores = lease.snapshot.createStores();
          expect(stores.modelRegistry.find("openai", modelId)).toMatchObject({
            provider: "openai",
            id: modelId,
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:9/v1",
          });
          expect(
            lease.snapshot.configuredRuntimeModels.map((entry) => ({
              provider: entry.provider,
              modelId: entry.modelId,
            })),
          ).toContainEqual({ provider: "openai", modelId });

          vi.spyOn(webMedia, "loadWebMediaRaw").mockResolvedValue({
            kind: "document",
            buffer: Buffer.from("%PDF-1.4 inline model fixture"),
            contentType: "application/pdf",
            fileName: "inline-model.pdf",
          });
          vi.spyOn(pdfExtractModule, "extractPdfContent").mockResolvedValue({
            text: "Inline model regression fixture",
            images: [],
          });
          completeMock.mockResolvedValue({
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "resolved inline model" }],
          });

          const { createPdfTool } = await import("./pdf-tool.js");
          const tool = createPdfTool({
            config,
            agentDir,
            preparedModelRuntime: lease.snapshot,
          });
          if (!tool) {
            throw new Error("expected PDF tool");
          }

          const result = await tool.execute("pdf-static-inline", {
            prompt: "Summarize",
            pdf: "/tmp/inline-model.pdf",
          });

          expect(completeMock).toHaveBeenCalledWith(
            expect.objectContaining({ provider: "openai", id: modelId }),
            expect.any(Object),
            expect.any(Object),
          );
          expect(result.details).toMatchObject({ model: modelRef, native: false });
        } finally {
          lease.release();
        }
      },
    );
  }, 180_000);
});
