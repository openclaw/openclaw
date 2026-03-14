import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createImageTool } from "./image-tool.js";

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-custom-provider-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

async function withTempWorkspacePng(
  cb: (args: { workspaceDir: string; imagePath: string }) => Promise<void>,
) {
  const workspaceParent = await fs.mkdtemp(path.join(process.cwd(), ".openclaw-workspace-image-"));
  try {
    const workspaceDir = path.join(workspaceParent, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    const imagePath = path.join(workspaceDir, "photo.png");
    await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
    await cb({ workspaceDir, imagePath });
  } finally {
    await fs.rm(workspaceParent, { recursive: true, force: true });
  }
}

function stubOpenAiCompletionsOkFetch(text = "ok") {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          const chunks = [
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "azure-gpt-5-mini",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: text },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
            `data: ${JSON.stringify({
              id: "chatcmpl-test",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "azure-gpt-5-mini",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ];
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ),
  );
  global.fetch = withFetchPreconnect(fetch);
  return fetch;
}

describe("image tool custom provider fallback", () => {
  const priorFetch = global.fetch;

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
    vi.stubEnv("LITELLM_API_KEY", "litellm-test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("uses configured custom provider image model even when registry lookup misses", async () => {
    stubOpenAiCompletionsOkFetch("custom provider ok");

    const cfg: OpenClawConfig = {
      models: {
        providers: {
          litellm: {
            baseUrl: "http://localhost:4000",
            api: "openai-completions",
            models: [
              {
                id: "azure-gpt-5-mini",
                name: "Azure GPT-5 Mini",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          imageModel: {
            primary: "litellm/azure-gpt-5-mini",
          },
        },
      },
    };

    await withTempAgentDir(async (agentDir) => {
      await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
        const tool = createImageTool({ config: cfg, agentDir, workspaceDir });
        expect(tool).not.toBeNull();
        if (!tool) {
          throw new Error("expected image tool");
        }

        await expect(
          tool.execute("t1", {
            prompt: "Describe the image.",
            image: imagePath,
          }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: "custom provider ok" }],
        });
      });
    });
  });
});
