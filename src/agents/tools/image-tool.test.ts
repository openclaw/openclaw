import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import type { SandboxFsBridge } from "../sandbox/fs-bridge.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { createUnsafeMountedSandbox } from "../test-helpers/unsafe-mounted-sandbox.js";
import { __testing, createImageTool, resolveImageModelConfigForTool } from "./image-tool.js";

type PiToolsModule = typeof import("../pi-tools.js");
type CreateOpenClawCodingToolsArgs = Parameters<PiToolsModule["createOpenClawCodingTools"]>[0];
type MockOpenClawToolsOptions = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  fsPolicy?: NonNullable<Parameters<typeof createImageTool>[0]>["fsPolicy"];
  modelHasVision?: boolean;
};

const piToolsHarness = vi.hoisted(() => ({
  createStubTool(name: string) {
    return {
      name,
      description: `${name} stub`,
      parameters: { type: "object", properties: {} },
      execute: vi.fn(),
    };
  },
}));

vi.mock("../bash-tools.js", () => ({
  createExecTool: vi.fn(() => piToolsHarness.createStubTool("exec")),
  createProcessTool: vi.fn(() => piToolsHarness.createStubTool("process")),
}));

vi.mock("../channel-tools.js", () => ({
  copyChannelAgentToolMeta: vi.fn((_from, to) => to),
  listChannelAgentTools: vi.fn(() => []),
}));

vi.mock("../apply-patch.js", () => ({
  createApplyPatchTool: vi.fn(() => piToolsHarness.createStubTool("apply_patch")),
}));

vi.mock("../pi-tools.before-tool-call.js", () => ({
  wrapToolWithBeforeToolCallHook: vi.fn((tool) => tool),
}));

vi.mock("../pi-tools.abort.js", () => ({
  wrapToolWithAbortSignal: vi.fn((tool) => tool),
}));

vi.mock("../openclaw-tools.js", async () => {
  const { createImageTool } = await import("./image-tool.js");
  return {
    createOpenClawTools: vi.fn((options?: MockOpenClawToolsOptions) => {
      const imageTool = createImageTool({
        config: options?.config,
        agentDir: options?.agentDir,
        workspaceDir: options?.workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? {
                root: options.sandboxRoot,
                bridge: options.sandboxFsBridge,
              }
            : undefined,
        fsPolicy: options?.fsPolicy,
        modelHasVision: options?.modelHasVision,
      });
      return imageTool ? [imageTool] : [];
    }),
  };
});

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

async function createOpenClawCodingToolsWithFreshModules(options?: CreateOpenClawCodingToolsArgs) {
  vi.resetModules();
  const { createOpenClawCodingTools } = await import("../pi-tools.js");
  return createOpenClawCodingTools(options);
}

async function withTempAgentDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
  try {
    return await run(agentDir);
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
  }
}

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";
const ONE_PIXEL_JPEG_B64 = "QUJDRA==";

async function withTempWorkspacePng(
  cb: (args: { workspaceDir: string; imagePath: string }) => Promise<void>,
  options?: { parentDir?: string },
) {
  const parentDir = options?.parentDir ?? os.tmpdir();
  const workspaceParent = await fs.mkdtemp(path.join(parentDir, "openclaw-workspace-image-"));
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

function registerImageToolEnvReset(priorFetch: typeof global.fetch, keys: string[]) {
  beforeEach(() => {
    for (const key of keys) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });
}

function stubMinimaxOkFetch() {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      content: "ok",
      base_resp: { status_code: 0, status_msg: "" },
    }),
  });
  global.fetch = withFetchPreconnect(fetch);
  vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
  return fetch;
}

function stubMinimaxFetch(baseResp: { status_code: number; status_msg: string }, content = "ok") {
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    json: async () => ({
      content,
      base_resp: baseResp,
    }),
  });
  global.fetch = withFetchPreconnect(fetch);
  return fetch;
}

function stubOpenAiCompletionsOkFetch(text = "ok") {
  const fetch = vi.fn().mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            const chunks = [
              `data: ${JSON.stringify({
                id: "chatcmpl-moonshot-test",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "kimi-k2.5",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: text },
                    finish_reason: null,
                  },
                ],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "chatcmpl-moonshot-test",
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: "kimi-k2.5",
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
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      ),
  );
  global.fetch = withFetchPreconnect(fetch);
  return fetch;
}

function createMinimaxImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "minimax/MiniMax-M2.7" },
        imageModel: { primary: "minimax/MiniMax-VL-01" },
      },
    },
    plugins: {
      entries: {
        minimax: { enabled: true },
      },
    },
  };
}

function createDefaultImageFallbackExpectation(primary: string) {
  return {
    primary,
    fallbacks: ["openai/gpt-5-mini", "anthropic/claude-opus-4-5"],
  };
}

function makeModelDefinition(id: string, input: Array<"text" | "image">): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  };
}

async function expectImageToolExecOk(
  tool: {
    execute: (toolCallId: string, input: { prompt: string; image: string }) => Promise<unknown>;
  },
  image: string,
) {
  await expect(
    tool.execute("t1", {
      prompt: "Describe the image.",
      image,
    }),
  ).resolves.toMatchObject({
    content: expect.arrayContaining([
      { type: "text", text: "Describe the image." },
      expect.objectContaining({ type: "image" }),
    ]),
  });
}

function requireImageTool<T>(tool: T | null | undefined): T {
  expect(tool).not.toBeNull();
  if (!tool) {
    throw new Error("expected image tool");
  }
  return tool;
}

function createRequiredImageTool(args: Parameters<typeof createImageTool>[0]) {
  return requireImageTool(createImageTool(args));
}

type ImageToolInstance = ReturnType<typeof createRequiredImageTool>;

async function withTempSandboxState(
  run: (ctx: { stateDir: string; agentDir: string; sandboxRoot: string }) => Promise<void>,
) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
  const agentDir = path.join(stateDir, "agent");
  const sandboxRoot = path.join(stateDir, "sandbox");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(sandboxRoot, { recursive: true });
  try {
    await run({ stateDir, agentDir, sandboxRoot });
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function withMinimaxImageToolFromTempAgentDir(
  run: (tool: ImageToolInstance) => Promise<void>,
) {
  await withTempAgentDir(async (agentDir) => {
    const cfg = createMinimaxImageConfig();
    await run(createRequiredImageTool({ config: cfg, agentDir }));
  });
}

function findSchemaUnionKeywords(schema: unknown, path = "root"): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findSchemaUnionKeywords(item, `${path}[${index}]`));
  }
  const record = schema as Record<string, unknown>;
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    const nextPath = `${path}.${key}`;
    if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      out.push(nextPath);
    }
    out.push(...findSchemaUnionKeywords(value, nextPath));
  }
  return out;
}

describe("image tool implicit imageModel config", () => {
  const priorFetch = global.fetch;
  registerImageToolEnvReset(priorFetch, [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_OAUTH_TOKEN",
    "MINIMAX_API_KEY",
    "ZAI_API_KEY",
    "Z_AI_API_KEY",
    // Avoid implicit Copilot provider discovery hitting the network in tests.
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);

  it("stays disabled without auth when no pairing is possible", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();
      expect(createImageTool({ config: cfg, agentDir })).toBeNull();
    });
  });

  it("pairs minimax primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(
        createDefaultImageFallbackExpectation("minimax/MiniMax-VL-01"),
      );
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs minimax-portal primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "oauth-test",
            refresh: "refresh-test",
            expires: Date.now() + 60_000,
          },
        },
      });
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax-portal/MiniMax-M2.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(
        createDefaultImageFallbackExpectation("minimax-portal/MiniMax-VL-01"),
      );
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs zai primary with glm-4.6v (and fallbacks) when auth exists", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("ZAI_API_KEY", "zai-test");
      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual(
        createDefaultImageFallbackExpectation("zai/glm-4.6v"),
      );
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs a custom provider when it declares an image-capable model", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "acme:default": { type: "api_key", provider: "acme", key: "sk-test" },
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "acme/text-1" } } },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "acme/vision-1",
      });
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("pairs a provider when config uses an alias key", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "amazon-bedrock:default": {
            type: "api_key",
            provider: "amazon-bedrock",
            key: "sk-test",
          },
        },
      });
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "aws-bedrock/text-1" } } },
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://example.com",
              models: [
                makeModelDefinition("text-1", ["text"]),
                makeModelDefinition("vision-1", ["text", "image"]),
              ],
            },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "amazon-bedrock/vision-1",
      });
      expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
    });
  });

  it("prefers explicit agents.defaults.imageModel", async () => {
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax/MiniMax-M2.7" },
            imageModel: { primary: "openai/gpt-5-mini" },
          },
        },
      };
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5-mini",
      });
    });
  });

  it("keeps image tool available when primary model supports images (for explicit requests)", async () => {
    // When the primary model supports images, we still keep the tool available
    // because images are auto-injected into prompts. The tool description is
    // adjusted via modelHasVision to discourage redundant usage.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    await withTempAgentDir(async (agentDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "acme/vision-1" },
            imageModel: { primary: "openai/gpt-5-mini" },
          },
        },
        models: {
          providers: {
            acme: {
              baseUrl: "https://example.com",
              models: [makeModelDefinition("vision-1", ["text", "image"])],
            },
          },
        },
      };
      // Tool should still be available for explicit image analysis requests
      expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
        primary: "openai/gpt-5-mini",
      });
      const tool = createImageTool({ config: cfg, agentDir, modelHasVision: true });
      expect(tool).not.toBeNull();
      expect(tool?.description).toContain(
        "Only use this tool when images were NOT already provided",
      );
    });
  });

  it("sends moonshot image requests with user+image payloads only", async () => {
    await withTempAgentDir(async (agentDir) => {
      vi.stubEnv("MOONSHOT_API_KEY", "moonshot-test");
      const fetch = stubOpenAiCompletionsOkFetch("ok moonshot");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "moonshot/kimi-k2.5" },
            imageModel: { primary: "moonshot/kimi-k2.5" },
          },
        },
        models: {
          providers: {
            moonshot: {
              api: "openai-completions",
              baseUrl: "https://api.moonshot.ai/v1",
              models: [makeModelDefinition("kimi-k2.5", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe this image in one word.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Describe this image in one word." }),
          expect.objectContaining({ type: "image" }),
        ]),
      );
    });
  });

  it("falls back to the generic image runtime when openrouter has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const fetch = stubOpenAiCompletionsOkFetch("ok openrouter");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openrouter/google/gemini-2.5-flash-lite" },
            imageModel: { primary: "openrouter/google/gemini-2.5-flash-lite" },
          },
        },
        models: {
          providers: {
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openrouter-test",
              models: [makeModelDefinition("google/gemini-2.5-flash-lite", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Describe the image." }),
          expect.objectContaining({ type: "image" }),
        ]),
      );
    });
  });

  it("falls back to the generic multi-image runtime when openrouter has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      const fetch = stubOpenAiCompletionsOkFetch("ok multi");
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "openrouter/google/gemini-2.5-flash-lite" },
            imageModel: { primary: "openrouter/google/gemini-2.5-flash-lite" },
          },
        },
        models: {
          providers: {
            openrouter: {
              api: "openai-completions",
              baseUrl: "https://openrouter.ai/api/v1",
              apiKey: "openrouter-test",
              models: [makeModelDefinition("google/gemini-2.5-flash-lite", ["text", "image"])],
            },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      const result = await tool.execute("t1", {
        prompt: "Describe the images.",
        images: [
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
          `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
        ],
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "Describe the images." }),
          expect.objectContaining({ type: "image" }),
        ]),
      );
      expect(
        result.content?.filter((block) => block.type === "image").length ?? 0,
      ).toBeGreaterThanOrEqual(1);
    });
  });

  it("falls back to the generic image runtime when minimax-portal has no media provider registration", async () => {
    await withTempAgentDir(async (agentDir) => {
      await writeAuthProfiles(agentDir, {
        version: 1,
        profiles: {
          "minimax-portal:default": {
            type: "oauth",
            provider: "minimax-portal",
            access: "oauth-test",
            refresh: "refresh-test",
            expires: Date.now() + 60_000,
          },
        },
      });
      const fetch = stubMinimaxOkFetch();
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax-portal/MiniMax-M2.7" },
            imageModel: { primary: "minimax-portal/MiniMax-VL-01" },
          },
        },
      };

      const tool = requireImageTool(createImageTool({ config: cfg, agentDir }));
      await expectImageToolExecOk(tool, `data:image/png;base64,${ONE_PIXEL_PNG_B64}`);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("exposes an Anthropic-safe image schema without union keywords", async () => {
    await withMinimaxImageToolFromTempAgentDir(async (tool) => {
      const violations = findSchemaUnionKeywords(tool.parameters, "image.parameters");
      expect(violations).toEqual([]);

      const schema = tool.parameters as {
        properties?: Record<string, unknown>;
      };
      const imageSchema = schema.properties?.image as { type?: unknown } | undefined;
      const imagesSchema = schema.properties?.images as
        | { type?: unknown; items?: unknown }
        | undefined;
      const imageItems = imagesSchema?.items as { type?: unknown } | undefined;

      expect(imageSchema?.type).toBe("string");
      expect(imagesSchema?.type).toBe("array");
      expect(imageItems?.type).toBe("string");
    });
  });

  it("keeps an Anthropic-safe image schema snapshot", async () => {
    await withMinimaxImageToolFromTempAgentDir(async (tool) => {
      expect(JSON.parse(JSON.stringify(tool.parameters))).toEqual({
        type: "object",
        properties: {
          prompt: { type: "string" },
          image: { description: "Single image path or URL.", type: "string" },
          images: {
            description: "Multiple image paths or URLs (up to maxImages, default 20).",
            type: "array",
            items: { type: "string" },
          },
          model: { type: "string" },
          maxBytesMb: { type: "number" },
          maxImages: { type: "number" },
        },
      });
    });
  });

  it("allows local image paths outside default media roots when workspaceOnly is off", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const withoutWorkspace = createRequiredImageTool({ config: cfg, agentDir });
        await expectImageToolExecOk(withoutWorkspace, imagePath);

        const withWorkspace = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        await expectImageToolExecOk(withWorkspace, imagePath);

        expect(fetch).not.toHaveBeenCalled();
      });
    });
  });

  it("respects fsPolicy.workspaceOnly for non-sandbox image paths", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const tool = createRequiredImageTool({
          config: cfg,
          agentDir,
          workspaceDir,
          fsPolicy: { workspaceOnly: true },
        });

        // File inside workspace is allowed.
        await expectImageToolExecOk(tool, imagePath);
        expect(fetch).not.toHaveBeenCalled();

        // File outside workspace is rejected even without sandbox.
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-outside-"));
        const outsideImage = path.join(outsideDir, "secret.png");
        await fs.writeFile(outsideImage, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
        try {
          await expect(
            tool.execute("t2", { prompt: "Describe.", image: outsideImage }),
          ).rejects.toThrow(/not under an allowed directory/i);
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      });
    });
  });

  it("allows non-workspace local image paths when workspaceOnly is disabled", async () => {
    const fetch = stubMinimaxOkFetch();
    await withTempAgentDir(async (agentDir) => {
      const cfg = createMinimaxImageConfig();
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-outside-"));
      const outsideImage = path.join(outsideDir, "secret.png");
      await fs.writeFile(outsideImage, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
      try {
        const tool = createRequiredImageTool({
          config: cfg,
          agentDir,
          fsPolicy: { workspaceOnly: false },
        });

        await expectImageToolExecOk(tool, outsideImage);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });
  });

  it("allows workspace images via createOpenClawCodingTools when workspace root is explicit", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();

        const tools = await createOpenClawCodingToolsWithFreshModules({
          config: cfg,
          agentDir,
          workspaceDir,
        });
        const tool = requireImageTool(tools.find((candidate) => candidate.name === "image"));

        await expectImageToolExecOk(tool, imagePath);

        expect(fetch).not.toHaveBeenCalled();
      });
    });
  });

  it("resolves relative image paths against workspaceDir", async () => {
    await withTempWorkspacePng(async ({ workspaceDir }) => {
      // Place image in a subdirectory of the workspace
      const subdir = path.join(workspaceDir, "inbox");
      await fs.mkdir(subdir, { recursive: true });
      const imagePath = path.join(subdir, "receipt.png");
      await fs.writeFile(imagePath, Buffer.from(ONE_PIXEL_PNG_B64, "base64"));

      const fetch = stubMinimaxOkFetch();
      await withTempAgentDir(async (agentDir) => {
        const cfg = createMinimaxImageConfig();
        const tool = createRequiredImageTool({ config: cfg, agentDir, workspaceDir });

        // Relative path should be resolved against workspaceDir
        await expectImageToolExecOk(tool, "inbox/receipt.png");
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  it("sandboxes image paths like the read tool", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(path.join(sandboxRoot, "img.png"), "fake", "utf8");
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

      vi.stubEnv("OPENAI_API_KEY", "openai-test");
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: { primary: "minimax/MiniMax-M2.7" } } },
      };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      await expect(tool.execute("t1", { image: "https://example.com/a.png" })).rejects.toThrow(
        /Sandboxed image tool does not allow remote URLs/i,
      );

      await expect(tool.execute("t2", { image: "../escape.png" })).rejects.toThrow(
        /escapes sandbox root/i,
      );
    });
  });

  it("applies tools.fs.workspaceOnly to image paths in sandbox mode", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.writeFile(
        path.join(agentDir, "secret.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );
      const sandbox = createUnsafeMountedSandbox({ sandboxRoot, agentRoot: agentDir });
      const fetch = stubMinimaxOkFetch();
      const cfg: OpenClawConfig = {
        ...createMinimaxImageConfig(),
        tools: { fs: { workspaceOnly: true } },
      };

      const tools = await createOpenClawCodingToolsWithFreshModules({
        config: cfg,
        agentDir,
        sandbox,
        workspaceDir: sandboxRoot,
      });
      const readTool = tools.find((candidate) => candidate.name === "read");
      if (!readTool) {
        throw new Error("expected read tool");
      }
      const imageTool = requireImageTool(tools.find((candidate) => candidate.name === "image"));

      await expect(readTool.execute("t1", { path: "/agent/secret.png" })).rejects.toThrow(
        /Path escapes sandbox root/i,
      );
      await expect(
        imageTool.execute("t2", {
          prompt: "Describe the image.",
          image: "/agent/secret.png",
        }),
      ).rejects.toThrow(/Path escapes sandbox root/i);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    await withTempSandboxState(async ({ agentDir, sandboxRoot }) => {
      await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(sandboxRoot, "media", "inbound", "photo.png"),
        Buffer.from(ONE_PIXEL_PNG_B64, "base64"),
      );

      const fetch = stubMinimaxOkFetch();

      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "minimax/MiniMax-M2.7" },
            imageModel: { primary: "minimax/MiniMax-VL-01" },
          },
        },
      };
      const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
      const tool = createRequiredImageTool({ config: cfg, agentDir, sandbox });

      const res = await tool.execute("t1", {
        prompt: "Describe the image.",
        image: "@/Users/steipete/.openclaw/media/inbound/photo.png",
      });

      expect(fetch).not.toHaveBeenCalled();
      expect((res.details as { rewrittenFrom?: string }).rewrittenFrom).toContain("photo.png");
    });
  });
});

describe("image tool data URL support", () => {
  it("decodes base64 image data URLs", () => {
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
    const out = __testing.decodeDataUrl(`data:image/png;base64,${pngB64}`);
    expect(out.kind).toBe("image");
    expect(out.mimeType).toBe("image/png");
    expect(out.buffer.length).toBeGreaterThan(0);
  });

  it("rejects non-image data URLs", () => {
    expect(() => __testing.decodeDataUrl("data:text/plain;base64,SGVsbG8=")).toThrow(
      /Unsupported data URL type/i,
    );
  });
});

describe("image tool MiniMax VLM routing", () => {
  const pngB64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
  const priorFetch = global.fetch;
  registerImageToolEnvReset(priorFetch, [
    "MINIMAX_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
  ]);

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetch = stubMinimaxFetch(baseResp, baseResp.status_code === 0 ? "ok" : "");

    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimax-vlm-"));
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg = createMinimaxImageConfig();
    const tool = createRequiredImageTool({ config: cfg, agentDir });
    return { fetch, tool };
  }

  it("accepts image for single-image requests and calls /v1/coding_plan/vlm", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: `data:image/png;base64,${pngB64}`,
    });

    expect(fetch).not.toHaveBeenCalled();
    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    expect(text).toBe("Describe the image.");
    expect(res.content?.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("accepts images[] for multi-image requests", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Compare these images.",
      images: [`data:image/png;base64,${pngB64}`, `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`],
    });

    expect(fetch).not.toHaveBeenCalled();
    const details = res.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(details?.images).toHaveLength(2);
    expect(res.content?.find((b) => b.type === "text")?.text).toBe("Compare these images.");
    expect(res.content?.filter((b) => b.type === "image").length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("combines image + images with dedupe and enforces maxImages", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [
        `data:image/png;base64,${pngB64}`,
        `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`,
        `data:image/jpeg;base64,${ONE_PIXEL_JPEG_B64}`,
      ],
    });

    expect(fetch).not.toHaveBeenCalled();
    const dedupedDetails = deduped.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(dedupedDetails?.images).toHaveLength(2);
    expect(
      deduped.content?.filter((block) => block.type === "image").length ?? 0,
    ).toBeGreaterThanOrEqual(1);

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(tooMany.details).toMatchObject({
      error: "too_many_images",
      count: 2,
      max: 1,
    });
  });

  it("does not call the MiniMax VLM endpoint anymore", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({
      status_code: 1004,
      status_msg: "bad key",
    });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: `data:image/png;base64,${pngB64}`,
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(res.content?.find((b) => b.type === "text")?.text).toBe("Describe the image.");
    expect(res.content?.filter((b) => b.type === "image")).toHaveLength(1);
  });
});
