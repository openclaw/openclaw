import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const loadConfig = vi.fn().mockReturnValue({});

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  readConfigFileSnapshot,
  writeConfigFile,
  loadConfig,
}));

function mockConfigSnapshot(config: Record<string, unknown> = {}) {
  readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config,
    issues: [],
    legacyIssues: [],
  });
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function getWrittenConfig() {
  return writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
}

function expectWrittenPrimaryModel(model: string) {
  expect(writeConfigFile).toHaveBeenCalledTimes(1);
  const written = getWrittenConfig();
  expect(written.agents).toEqual({
    defaults: {
      model: { primary: model },
      models: { [model]: {} },
    },
  });
}

let modelsSetCommand: typeof import("./models/set.js").modelsSetCommand;
let modelsFallbacksAddCommand: typeof import("./models/fallbacks.js").modelsFallbacksAddCommand;

describe("models set + fallbacks", () => {
  beforeAll(async () => {
    ({ modelsSetCommand } = await import("./models/set.js"));
    ({ modelsFallbacksAddCommand } = await import("./models/fallbacks.js"));
  });

  beforeEach(() => {
    readConfigFileSnapshot.mockClear();
    writeConfigFile.mockClear();
  });

  it("normalizes z.ai provider in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("z.ai/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("normalizes z-ai provider in models fallbacks add", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("z-ai/glm-4.7", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("preserves primary when adding fallbacks to string defaults.model", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("anthropic/claude-opus-4-6", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-opus-4-6"],
        },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });

  it("normalizes provider casing in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("Z.AI/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("rewrites string defaults.model to object form when setting primary", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsSetCommand("anthropic/claude-opus-4-6", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });

  it("rejects model without provider prefix (#5790)", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    // Should reject "qwen2.5-coder:7b" without a provider prefix
    await expect(modelsSetCommand("qwen2.5-coder:7b", runtime)).rejects.toThrow(
      /requires a provider prefix/i,
    );

    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("accepts model with explicit provider prefix (#5790)", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("ollama/qwen2.5-coder:7b", runtime);

    expectWrittenPrimaryModel("ollama/qwen2.5-coder:7b");
  });

  it("accepts model alias without provider prefix (#5790)", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: {
          models: {
            "openai/gpt-4.1": { alias: "gpt4" },
          },
        },
      },
    });
    const runtime = makeRuntime();

    await modelsSetCommand("gpt4", runtime);

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = getWrittenConfig();
    expect(
      (written.agents as { defaults: { model: { primary: string } } }).defaults.model.primary,
    ).toBe("openai/gpt-4.1");
  });
});
