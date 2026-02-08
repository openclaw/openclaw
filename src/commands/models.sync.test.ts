import type { Model } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfig = vi.fn().mockReturnValue({});
const ensureOpenClawModelsJson = vi.fn().mockResolvedValue(undefined);
const resolveOpenClawAgentDir = vi.fn();
const fetchOpenRouterModels = vi.fn();
const getModel = vi.fn();

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  loadConfig,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson,
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

vi.mock("@mariozechner/pi-ai", () => ({
  getModel,
}));

vi.mock("../agents/openrouter-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/openrouter-catalog.js")>(
    "../agents/openrouter-catalog.js",
  );
  return { ...actual, fetchOpenRouterModels };
});

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn() };
}

describe("models sync openrouter", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-models-"));
    resolveOpenClawAgentDir.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("writes filtered OpenRouter models to models.json", async () => {
    const baseModel = {
      id: "openrouter/auto",
      name: "OpenRouter: Auto Router",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 2000000,
      maxTokens: 30000,
    } satisfies Model<"openai-completions">;

    getModel.mockReturnValue(baseModel);
    fetchOpenRouterModels.mockResolvedValue([
      {
        id: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextLength: 200000,
        maxCompletionTokens: 8192,
        supportedParameters: ["tools"],
        supportedParametersCount: 1,
        supportsToolsMeta: true,
        modality: "text+image",
        inferredParamB: 80,
        createdAtMs: null,
        pricing: {
          prompt: 0,
          completion: 0,
          request: 0,
          image: 0,
          webSearch: 0,
          internalReasoning: 0,
        },
      },
      {
        id: "openai/gpt-5.2",
        name: "GPT-5.2",
        contextLength: 200000,
        maxCompletionTokens: 8192,
        supportedParameters: ["tools"],
        supportedParametersCount: 1,
        supportsToolsMeta: true,
        modality: "text",
        inferredParamB: 0,
        createdAtMs: null,
        pricing: {
          prompt: 1,
          completion: 2,
          request: 0,
          image: 0,
          webSearch: 0,
          internalReasoning: 0,
        },
      },
    ]);

    const runtime = makeRuntime();
    const { modelsSyncOpenRouterCommand } = await import("./models/sync.js");

    await modelsSyncOpenRouterCommand({ provider: "anthropic", freeOnly: true }, runtime as never);

    const modelsPath = path.join(tempDir, "models.json");
    const raw = await fs.readFile(modelsPath, "utf8");
    const parsed = JSON.parse(raw) as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };

    const models = parsed.providers?.openrouter?.models ?? [];
    const ids = models.map((entry) => entry.id);
    expect(ids).toContain("openrouter/auto");
    expect(ids).toContain("anthropic/claude-sonnet-4-5");
    expect(ids).not.toContain("openai/gpt-5.2");
    expect(runtime.log).toHaveBeenCalled();
  });
});
