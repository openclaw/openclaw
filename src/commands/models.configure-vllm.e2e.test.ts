import { beforeEach, describe, expect, it, vi } from "vitest";

const readConfigFileSnapshot = vi.fn();
const writeConfigFile = vi.fn().mockResolvedValue(undefined);
const loadConfig = vi.fn().mockReturnValue({});

const upsertAuthProfileWithLock = vi.fn().mockResolvedValue(undefined);

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "/tmp/openclaw.json",
  readConfigFileSnapshot,
  writeConfigFile,
  loadConfig,
}));

vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfileWithLock,
}));

describe("models configure vllm", () => {
  beforeEach(() => {
    readConfigFileSnapshot.mockReset();
    writeConfigFile.mockClear();
    upsertAuthProfileWithLock.mockClear();
  });

  it("upserts vllm config + default model", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      valid: true,
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:9000/v1",
              apiKey: "OLD_KEY",
              api: "openai-completions",
              models: [
                {
                  id: "old-model",
                  name: "old-model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 4096,
                  maxTokens: 2048,
                },
              ],
            },
          },
        },
      },
      issues: [],
      legacyIssues: [],
    });

    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const { modelsConfigureVllmCommand } = await import("./models/configure-vllm.js");

    await modelsConfigureVllmCommand(
      {
        baseUrl: "http://127.0.0.1:8000/v1",
        apiKey: "sk-vllm-test",
        modelId: "meta-llama/Meta-Llama-3-8B-Instruct",
      },
      runtime,
    );

    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith({
      profileId: "vllm:default",
      credential: { type: "api_key", provider: "vllm", key: "sk-vllm-test" },
      agentDir: expect.any(String),
    });

    expect(writeConfigFile).toHaveBeenCalledTimes(1);
    const written = writeConfigFile.mock.calls[0]?.[0] as Record<string, unknown>;
    const providers = (written.models as { providers?: Record<string, unknown> } | undefined)
      ?.providers as Record<
      string,
      { baseUrl?: string; apiKey?: string; models?: Array<{ id: string }> }
    >;
    const vllm = providers?.vllm;
    expect(vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(vllm?.apiKey).toBe("VLLM_API_KEY");

    const modelIds = vllm?.models?.map((entry) => entry.id);
    expect(modelIds).toEqual(
      expect.arrayContaining(["old-model", "meta-llama/Meta-Llama-3-8B-Instruct"]),
    );

    const defaults = (written.agents as { defaults?: { model?: { primary?: string } } } | undefined)
      ?.defaults;
    expect(defaults?.model?.primary).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");

    const allowlist =
      (written.agents as { defaults?: { models?: Record<string, unknown> } } | undefined)?.defaults
        ?.models ?? {};
    expect(Object.keys(allowlist)).toContain("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
  });
});
