import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let modelsListCommand: typeof import("./models/list.list-command.js").modelsListCommand;

const loadConfig = vi.fn();
const ensureOpenClawModelsJson = vi.fn().mockResolvedValue(undefined);
const resolveOpenClawAgentDir = vi.fn().mockReturnValue("/tmp/openclaw-agent");
const ensureAuthProfileStore = vi.fn().mockReturnValue({ version: 1, profiles: {} });
const listProfilesForProvider = vi.fn().mockReturnValue([]);
const resolveAuthProfileDisplayLabel = vi.fn(({ profileId }: { profileId: string }) => profileId);
const resolveAuthStorePathForDisplay = vi
  .fn()
  .mockReturnValue("/tmp/openclaw-agent/auth-profiles.json");
const resolveProfileUnusableUntilForDisplay = vi.fn().mockReturnValue(null);
const resolveEnvApiKey = vi.fn().mockReturnValue(undefined);
const resolveAwsSdkEnvVarName = vi.fn().mockReturnValue(undefined);
const getCustomProviderApiKey = vi.fn().mockReturnValue(undefined);
const modelRegistryState = {
  models: [] as Array<Record<string, unknown>>,
  available: [] as Array<Record<string, unknown>>,
  getAllError: undefined as unknown,
  getAvailableError: undefined as unknown,
};
let previousExitCode: number | undefined;

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  STATE_DIR: "/tmp/openclaw-state",
  loadConfig,
}));

vi.mock("../agents/models-config.js", () => ({
  ensureOpenClawModelsJson,
}));

vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveAuthProfileDisplayLabel,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  resolveAwsSdkEnvVarName,
  getCustomProviderApiKey,
}));

vi.mock("../agents/pi-model-discovery.js", () => {
  class MockModelRegistry {
    find(provider: string, id: string) {
      return (
        modelRegistryState.models.find((model) => model.provider === provider && model.id === id) ??
        null
      );
    }

    getAll() {
      if (modelRegistryState.getAllError !== undefined) {
        throw modelRegistryState.getAllError;
      }
      return modelRegistryState.models;
    }

    getAvailable() {
      if (modelRegistryState.getAvailableError !== undefined) {
        throw modelRegistryState.getAvailableError;
      }
      return modelRegistryState.available;
    }
  }

  return {
    discoverAuthStorage: () => ({}) as unknown,
    discoverModels: () => new MockModelRegistry() as unknown,
  };
});

vi.mock("../agents/pi-embedded-runner/model.js", () => ({
  resolveModel: () => {
    throw new Error("resolveModel should not be called from models.list tests");
  },
}));

function makeRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  };
}

beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  modelRegistryState.getAllError = undefined;
  modelRegistryState.getAvailableError = undefined;
  listProfilesForProvider.mockReturnValue([]);
});

afterEach(() => {
  process.exitCode = previousExitCode;
});

describe("models list/status", () => {
  const ZAI_MODEL = {
    provider: "zai",
    id: "glm-4.7",
    name: "GLM-4.7",
    input: ["text"],
    baseUrl: "https://api.z.ai/v1",
    contextWindow: 128000,
  };
  const OPENAI_MODEL = {
    provider: "openai",
    id: "gpt-4.1-mini",
    name: "GPT-4.1 mini",
    input: ["text"],
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 128000,
  };

  function setDefaultModel(model: string) {
    loadConfig.mockReturnValue({
      agents: { defaults: { model } },
    });
  }

  function parseJsonLog(runtime: ReturnType<typeof makeRuntime>) {
    expect(runtime.log).toHaveBeenCalledTimes(1);
    return JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
  }

  async function expectZaiProviderFilter(provider: string) {
    setDefaultModel("z.ai/glm-4.7");
    const runtime = makeRuntime();
    const models = [ZAI_MODEL, OPENAI_MODEL];
    modelRegistryState.models = models;
    modelRegistryState.available = models;

    await modelsListCommand({ all: true, provider, json: true }, runtime);

    const payload = parseJsonLog(runtime);
    expect(payload.count).toBe(1);
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  }

  beforeAll(async () => {
    ({ modelsListCommand } = await import("./models/list.list-command.js"));
  });

  it("models list outputs canonical zai key for configured z.ai model", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    modelRegistryState.models = [model];
    modelRegistryState.available = [model];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("zai/glm-4.7");
  });

  it("models list plain outputs canonical zai key", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    modelRegistryState.models = [model];
    modelRegistryState.available = [model];
    await modelsListCommand({ plain: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log.mock.calls[0]?.[0]).toBe("zai/glm-4.7");
  });

  it("models list provider filter normalizes Z.AI alias casing", async () => {
    await expectZaiProviderFilter("Z.AI");
  });

  it("models list marks auth as unavailable when ZAI key is missing", async () => {
    loadConfig.mockReturnValue({
      agents: { defaults: { model: "z.ai/glm-4.7" } },
    });
    const runtime = makeRuntime();

    const model = {
      provider: "zai",
      id: "glm-4.7",
      name: "GLM-4.7",
      input: ["text"],
      baseUrl: "https://api.z.ai/v1",
      contextWindow: 128000,
    };

    modelRegistryState.models = [model];
    modelRegistryState.available = [];
    await modelsListCommand({ all: true, json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.available).toBe(false);
  });

  it("models list resolves antigravity opus 4.6 thinking from 4.5 template", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.tags).toContain("default");
    expect(payload.models[0]?.tags).toContain("configured");
  });

  it("models list resolves antigravity opus 4.6 (non-thinking) from 4.5 template", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6",
          models: {
            "google-antigravity/claude-opus-4-6": {},
          },
        },
      },
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.tags).toContain("default");
    expect(payload.models[0]?.tags).toContain("configured");
  });

  it("models list marks synthesized antigravity opus 4.6 thinking as available when template is available", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    const runtime = makeRuntime();

    const template = {
      provider: "google-antigravity",
      id: "claude-opus-4-5-thinking",
      name: "Claude Opus 4.5 Thinking",
      api: "google-gemini-cli",
      input: ["text", "image"],
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    modelRegistryState.models = [template];
    modelRegistryState.available = [template];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.available).toBe(true);
  });

  it("models list prefers registry availability over provider auth heuristics", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
    const runtime = makeRuntime();

    const template = {
      provider: "google-antigravity",
      id: "claude-opus-4-5-thinking",
      name: "Claude Opus 4.5 Thinking",
      api: "google-gemini-cli",
      input: ["text", "image"],
      baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
      contextWindow: 200000,
      maxTokens: 64000,
      reasoning: true,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    };
    modelRegistryState.models = [template];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.available).toBe(false);
    listProfilesForProvider.mockReturnValue([]);
  });

  it("models list falls back to auth heuristics when registry availability is unavailable", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
    modelRegistryState.getAvailableError = Object.assign(
      new Error("availability unsupported: getAvailable failed"),
      { code: "MODEL_AVAILABILITY_UNAVAILABLE" },
    );
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("falling back to auth heuristics");
    expect(runtime.error.mock.calls[0]?.[0]).toContain("getAvailable failed");
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.available).toBe(true);
  });

  it("models list falls back to auth heuristics when getAvailable returns invalid shape", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
    modelRegistryState.available = { bad: true } as unknown as Array<Record<string, unknown>>;
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("falling back to auth heuristics");
    expect(runtime.error.mock.calls[0]?.[0]).toContain("non-array value");
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.available).toBe(true);
  });

  it("models list falls back to auth heuristics when getAvailable throws", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
    modelRegistryState.getAvailableError = new Error(
      "availability unsupported: getAvailable failed",
    );
    const runtime = makeRuntime();

    modelRegistryState.models = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("falling back to auth heuristics");
    expect(runtime.error.mock.calls[0]?.[0]).toContain(
      "availability unsupported: getAvailable failed",
    );
    expect(runtime.log).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
    expect(payload.models[0]?.key).toBe("google-antigravity/claude-opus-4-6-thinking");
    expect(payload.models[0]?.missing).toBe(false);
    expect(payload.models[0]?.available).toBe(true);
  });

  it("models list does not treat availability-unavailable code as discovery fallback", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    modelRegistryState.getAllError = Object.assign(new Error("model discovery failed"), {
      code: "MODEL_AVAILABILITY_UNAVAILABLE",
    });
    const runtime = makeRuntime();
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("Model registry unavailable:");
    expect(runtime.error.mock.calls[0]?.[0]).toContain("model discovery failed");
    expect(runtime.error.mock.calls[0]?.[0]).not.toContain("configured models may appear missing");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("models list fails fast when registry model discovery is unavailable", async () => {
    loadConfig.mockReturnValue({
      agents: {
        defaults: {
          model: "google-antigravity/claude-opus-4-6-thinking",
          models: {
            "google-antigravity/claude-opus-4-6-thinking": {},
          },
        },
      },
    });
    listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
      provider === "google-antigravity"
        ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
        : [],
    );
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    const runtime = makeRuntime();

    modelRegistryState.models = [];
    modelRegistryState.available = [];
    await modelsListCommand({ json: true }, runtime);

    expect(runtime.error).toHaveBeenCalledTimes(1);
    expect(runtime.error.mock.calls[0]?.[0]).toContain("Model registry unavailable:");
    expect(runtime.error.mock.calls[0]?.[0]).toContain("model discovery unavailable");
    expect(runtime.log).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("loadModelRegistry throws when model discovery is unavailable", async () => {
    modelRegistryState.getAllError = Object.assign(new Error("model discovery unavailable"), {
      code: "MODEL_DISCOVERY_UNAVAILABLE",
    });
    modelRegistryState.available = [
      {
        provider: "google-antigravity",
        id: "claude-opus-4-5-thinking",
        name: "Claude Opus 4.5 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ];

    const { loadModelRegistry } = await import("./models/list.registry.js");
    await expect(loadModelRegistry({})).rejects.toThrow("model discovery unavailable");
  });

  it("toModelRow does not crash without cfg/authStore when availability is undefined", async () => {
    const { toModelRow } = await import("./models/list.registry.js");

    const row = toModelRow({
      model: {
        provider: "google-antigravity",
        id: "claude-opus-4-6-thinking",
        name: "Claude Opus 4.6 Thinking",
        api: "google-gemini-cli",
        input: ["text", "image"],
        baseUrl: "https://daily-cloudcode-pa.sandbox.googleapis.com",
        contextWindow: 200000,
        maxTokens: 64000,
        reasoning: true,
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
      key: "google-antigravity/claude-opus-4-6-thinking",
      tags: [],
      availableKeys: undefined,
    });

    expect(row.missing).toBe(false);
    expect(row.available).toBe(false);
  });
});
