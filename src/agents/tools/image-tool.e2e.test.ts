import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { createHostSandboxFsBridge } from "../test-helpers/host-sandbox-fs-bridge.js";
import { __testing, createImageTool, resolveImageModelConfigForTool } from "./image-tool.js";

async function writeAuthProfiles(agentDir: string, profiles: unknown) {
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, "auth-profiles.json"),
    `${JSON.stringify(profiles, null, 2)}\n`,
    "utf8",
  );
}

const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
const ONE_PIXEL_GIF_B64 = "R0lGODlhAQABAIABAP///wAAACwAAAAAAQABAAACAkQBADs=";

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

function createMinimaxImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "minimax/MiniMax-M2.1" },
        imageModel: { primary: "minimax/MiniMax-VL-01" },
      },
    },
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
    content: [{ type: "text", text: "ok" }],
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

  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    vi.stubEnv("MINIMAX_API_KEY", "");
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("Z_AI_API_KEY", "");
    // Avoid implicit Copilot provider discovery hitting the network in tests.
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  it("stays disabled without auth when no pairing is possible", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "openai/gpt-5.2" } } },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();
    expect(createImageTool({ config: cfg, agentDir })).toBeNull();
  });

  it("pairs minimax primary with MiniMax-VL-01 (and fallbacks) when auth exists", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "minimax/MiniMax-VL-01",
      fallbacks: ["openai/gpt-5-mini", "anthropic/claude-opus-4-5"],
    });
    expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
  });

  it("pairs zai primary with glm-4.6v (and fallbacks) when auth exists", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    vi.stubEnv("ZAI_API_KEY", "zai-test");
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test");
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "zai/glm-4.7" } } },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "zai/glm-4.6v",
      fallbacks: ["openai/gpt-5-mini", "anthropic/claude-opus-4-5"],
    });
    expect(createImageTool({ config: cfg, agentDir })).not.toBeNull();
  });

  it("pairs a custom provider when it declares an image-capable model", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
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

  it("prefers explicit agents.defaults.imageModel", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.1" },
          imageModel: { primary: "openai/gpt-5-mini" },
        },
      },
    };
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: "openai/gpt-5-mini",
    });
  });

  it("keeps image tool available when primary model supports images (for explicit requests)", async () => {
    // When the primary model supports images, we still keep the tool available
    // because images are auto-injected into prompts. The tool description is
    // adjusted via modelHasVision to discourage redundant usage.
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
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
    expect(tool?.description).toContain("Only use this tool when images were NOT already provided");
  });

  it("exposes an Anthropic-safe image schema without union keywords", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    try {
      const cfg = createMinimaxImageConfig();
      const tool = createImageTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      if (!tool) {
        throw new Error("expected image tool");
      }

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
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps an Anthropic-safe image schema snapshot", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
    try {
      const cfg = createMinimaxImageConfig();
      const tool = createImageTool({ config: cfg, agentDir });
      expect(tool).not.toBeNull();
      if (!tool) {
        throw new Error("expected image tool");
      }

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
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("allows workspace images outside default local media roots", async () => {
    await withTempWorkspacePng(async ({ workspaceDir, imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
      try {
        const cfg = createMinimaxImageConfig();

        const withoutWorkspace = createImageTool({ config: cfg, agentDir });
        expect(withoutWorkspace).not.toBeNull();
        if (!withoutWorkspace) {
          throw new Error("expected image tool");
        }
        await expect(
          withoutWorkspace.execute("t0", {
            prompt: "Describe the image.",
            image: imagePath,
          }),
        ).rejects.toThrow(/Local media path is not under an allowed directory/i);

        const withWorkspace = createImageTool({ config: cfg, agentDir, workspaceDir });
        expect(withWorkspace).not.toBeNull();
        if (!withWorkspace) {
          throw new Error("expected image tool");
        }

        await expectImageToolExecOk(withWorkspace, imagePath);

        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    });
  });

  it("allows workspace images via createOpenClawCodingTools default workspace root", async () => {
    await withTempWorkspacePng(async ({ imagePath }) => {
      const fetch = stubMinimaxOkFetch();
      const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-"));
      try {
        const cfg = createMinimaxImageConfig();

        const tools = createOpenClawCodingTools({ config: cfg, agentDir });
        const tool = tools.find((candidate) => candidate.name === "image");
        expect(tool).not.toBeNull();
        if (!tool) {
          throw new Error("expected image tool");
        }

        await expectImageToolExecOk(tool, imagePath);

        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        await fs.rm(agentDir, { recursive: true, force: true });
      }
    });
  });

  it("sandboxes image paths like the read tool", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
    const agentDir = path.join(stateDir, "agent");
    const sandboxRoot = path.join(stateDir, "sandbox");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(sandboxRoot, { recursive: true });
    await fs.writeFile(path.join(sandboxRoot, "img.png"), "fake", "utf8");
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };

    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
    };
    const tool = createImageTool({ config: cfg, agentDir, sandbox });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image tool");
    }

    await expect(tool.execute("t1", { image: "https://example.com/a.png" })).rejects.toThrow(
      /Sandboxed image tool does not allow remote URLs/i,
    );

    await expect(tool.execute("t2", { image: "../escape.png" })).rejects.toThrow(
      /escapes sandbox root/i,
    );
  });

  it("rewrites inbound absolute paths into sandbox media/inbound", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-image-sandbox-"));
    const agentDir = path.join(stateDir, "agent");
    const sandboxRoot = path.join(stateDir, "sandbox");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.mkdir(path.join(sandboxRoot, "media", "inbound"), {
      recursive: true,
    });
    const pngB64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
    await fs.writeFile(
      path.join(sandboxRoot, "media", "inbound", "photo.png"),
      Buffer.from(pngB64, "base64"),
    );

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

    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "minimax/MiniMax-M2.1" },
          imageModel: { primary: "minimax/MiniMax-VL-01" },
        },
      },
    };
    const sandbox = { root: sandboxRoot, bridge: createHostSandboxFsBridge(sandboxRoot) };
    const tool = createImageTool({ config: cfg, agentDir, sandbox });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image tool");
    }

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: "@/Users/steipete/.openclaw/media/inbound/photo.png",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((res.details as { rewrittenFrom?: string }).rewrittenFrom).toContain("photo.png");
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

  beforeEach(() => {
    vi.stubEnv("MINIMAX_API_KEY", "");
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = priorFetch;
  });

  async function createMinimaxVlmFixture(baseResp: { status_code: number; status_msg: string }) {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      json: async () => ({
        content: baseResp.status_code === 0 ? "ok" : "",
        base_resp: baseResp,
      }),
    });
    global.fetch = withFetchPreconnect(fetch);

    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimax-vlm-"));
    vi.stubEnv("MINIMAX_API_KEY", "minimax-test");
    const cfg: OpenClawConfig = {
      agents: { defaults: { model: { primary: "minimax/MiniMax-M2.1" } } },
    };
    const tool = createImageTool({ config: cfg, agentDir });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image tool");
    }
    return { fetch, tool };
  }

  it("accepts image for single-image requests and calls /v1/coding_plan/vlm", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Describe the image.",
      image: `data:image/png;base64,${pngB64}`,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://api.minimax.io/v1/coding_plan/vlm");
    expect(init?.method).toBe("POST");
    expect(String((init?.headers as Record<string, string>)?.Authorization)).toBe(
      "Bearer minimax-test",
    );
    expect(String(init?.body)).toContain('"prompt":"Describe the image."');
    expect(String(init?.body)).toContain('"image_url":"data:image/png;base64,');

    const text = res.content?.find((b) => b.type === "text")?.text ?? "";
    expect(text).toBe("ok");
  });

  it("accepts images[] for multi-image requests", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const res = await tool.execute("t1", {
      prompt: "Compare these images.",
      images: [`data:image/png;base64,${pngB64}`, `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const details = res.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(details?.images).toHaveLength(2);
  });

  it("combines image + images with dedupe and enforces maxImages", async () => {
    const { fetch, tool } = await createMinimaxVlmFixture({ status_code: 0, status_msg: "" });

    const deduped = await tool.execute("t1", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [
        `data:image/png;base64,${pngB64}`,
        `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`,
        `data:image/gif;base64,${ONE_PIXEL_GIF_B64}`,
      ],
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const dedupedDetails = deduped.details as
      | {
          images?: Array<{ image: string }>;
        }
      | undefined;
    expect(dedupedDetails?.images).toHaveLength(2);

    const tooMany = await tool.execute("t2", {
      prompt: "Compare these images.",
      image: `data:image/png;base64,${pngB64}`,
      images: [`data:image/gif;base64,${ONE_PIXEL_GIF_B64}`],
      maxImages: 1,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(tooMany.details).toMatchObject({
      error: "too_many_images",
      count: 2,
      max: 1,
    });
  });

  it("surfaces MiniMax API errors from /v1/coding_plan/vlm", async () => {
    const { tool } = await createMinimaxVlmFixture({ status_code: 1004, status_msg: "bad key" });

    await expect(
      tool.execute("t1", {
        prompt: "Describe the image.",
        image: `data:image/png;base64,${pngB64}`,
      }),
    ).rejects.toThrow(/MiniMax VLM API error/i);
  });
});

describe("image tool response validation", () => {
  function zeroUsage() {
    return {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    };
  }

  function createAssistantMessage(
    overrides: Partial<{
      api: string;
      provider: string;
      model: string;
      stopReason: string;
      errorMessage: string;
      content: unknown[];
    }>,
  ) {
    return {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5-mini",
      stopReason: "stop",
      timestamp: Date.now(),
      usage: zeroUsage(),
      content: [] as unknown[],
      ...overrides,
    };
  }

  it("caps image-tool max tokens by model capability", () => {
    expect(__testing.resolveImageToolMaxTokens(4000)).toBe(4000);
  });

  it("keeps requested image-tool max tokens when model capability is higher", () => {
    expect(__testing.resolveImageToolMaxTokens(8192)).toBe(4096);
  });

  it("falls back to requested image-tool max tokens when model capability is missing", () => {
    expect(__testing.resolveImageToolMaxTokens(undefined)).toBe(4096);
  });

  it("rejects image-model responses with no final text", () => {
    expect(() =>
      __testing.coerceImageAssistantText({
        provider: "openai",
        model: "gpt-5-mini",
        message: createAssistantMessage({
          content: [{ type: "thinking", thinking: "hmm" }],
        }) as never,
      }),
    ).toThrow(/returned no text/i);
  });

  it("surfaces provider errors from image-model responses", () => {
    expect(() =>
      __testing.coerceImageAssistantText({
        provider: "openai",
        model: "gpt-5-mini",
        message: createAssistantMessage({
          stopReason: "error",
          errorMessage: "boom",
        }) as never,
      }),
    ).toThrow(/boom/i);
  });

  it("returns trimmed text from image-model responses", () => {
    const text = __testing.coerceImageAssistantText({
      provider: "anthropic",
      model: "claude-opus-4-5",
      message: {
        ...createAssistantMessage({
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-opus-4-5",
        }),
        content: [{ type: "text", text: "  hello  " }],
      } as never,
    });
    expect(text).toBe("hello");
  });
});
