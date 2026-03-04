import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./ollama-setup.js";

const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfileWithLock,
}));

const openUrlMock = vi.hoisted(() => vi.fn(async () => false));
vi.mock("./onboard-helpers.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./onboard-helpers.js")>();
  return { ...original, openUrl: openUrlMock };
});

const isRemoteEnvironmentMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment: isRemoteEnvironmentMock,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ollama setup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    upsertAuthProfileWithLock.mockClear();
    openUrlMock.mockClear();
    isRemoteEnvironmentMock.mockReset().mockReturnValue(false);
  });

  it("returns suggested default model for local mode", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("local"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.defaultModelId).toBe("glm-4.7-flash");
  });

  it("returns suggested default model for remote mode", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("remote"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }))
      .mockResolvedValueOnce(jsonResponse({ username: "testuser" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.defaultModelId).toBe("kimi-k2.5:cloud");
  });

  it("mode selection affects model ordering (local)", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("local"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ models: [{ name: "llama3:8b" }, { name: "glm-4.7-flash" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(result.defaultModelId).toBe("glm-4.7-flash");
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);
    expect(modelIds?.[0]).toBe("glm-4.7-flash");
    expect(modelIds).toContain("llama3:8b");
  });

  it("cloud+local mode triggers /api/me check and opens sign-in URL", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("remote"),
      confirm: vi.fn().mockResolvedValueOnce(true),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "not signed in", signin_url: "https://ollama.com/signin" }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ username: "testuser" }));
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(openUrlMock).toHaveBeenCalledWith("https://ollama.com/signin");
    expect(prompter.confirm).toHaveBeenCalled();
  });

  it("cloud+local mode does not open browser in remote environment", async () => {
    isRemoteEnvironmentMock.mockReturnValue(true);
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("remote"),
      confirm: vi.fn().mockResolvedValueOnce(true),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "not signed in", signin_url: "https://ollama.com/signin" }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ username: "testuser" }));
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("local mode does not trigger cloud auth", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("local"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await promptAndConfigureOllama({ cfg: {}, prompter });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/api/tags");
  });

  it("suggested models appear first in model list (cloud+local)", async () => {
    const prompter = {
      text: vi.fn().mockResolvedValueOnce("http://127.0.0.1:11434"),
      select: vi.fn().mockResolvedValueOnce("remote"),
      note: vi.fn(async () => undefined),
    } as unknown as WizardPrompter;

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          models: [{ name: "llama3:8b" }, { name: "glm-4.7-flash" }, { name: "deepseek-r1:14b" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ username: "testuser" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await promptAndConfigureOllama({ cfg: {}, prompter });
    const modelIds = result.config.models?.providers?.ollama?.models?.map((m) => m.id);

    expect(modelIds).toEqual([
      "kimi-k2.5:cloud",
      "minimax-m2.5:cloud",
      "glm-5:cloud",
      "llama3:8b",
      "glm-4.7-flash",
      "deepseek-r1:14b",
    ]);
  });

  describe("ensureOllamaModelPulled", () => {
    it("pulls model when not available locally", async () => {
      const progress = { update: vi.fn(), stop: vi.fn() };
      const prompter = {
        progress: vi.fn(() => progress),
      } as unknown as WizardPrompter;

      const fetchMock = vi
        .fn()
        // /api/tags — model not present
        .mockResolvedValueOnce(jsonResponse({ models: [{ name: "llama3:8b" }] }))
        // /api/pull
        .mockResolvedValueOnce(new Response('{"status":"success"}\n', { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "ollama/glm-4.7-flash" } } },
          models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
        },
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain("/api/pull");
    });

    it("skips pull when model is already available", async () => {
      const prompter = {} as unknown as WizardPrompter;

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ models: [{ name: "glm-4.7-flash" }] }));
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "ollama/glm-4.7-flash" } } },
          models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
        },
        prompter,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("skips pull for cloud models", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "ollama/kimi-k2.5:cloud" } } },
          models: { providers: { ollama: { baseUrl: "http://127.0.0.1:11434", models: [] } } },
        },
        prompter,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("skips when model is not an ollama model", async () => {
      const prompter = {} as unknown as WizardPrompter;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await ensureOllamaModelPulled({
        config: {
          agents: { defaults: { model: { primary: "openai/gpt-4o" } } },
        },
        prompter,
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it("uses discovered model when requested non-interactive download fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [{ name: "qwen2.5-coder:7b" }] }))
      .mockResolvedValueOnce(new Response('{"error":"disk full"}\n', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;

    const result = await configureOllamaNonInteractive({
      nextConfig: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-4o-mini",
              fallbacks: ["anthropic/claude-sonnet-4-5"],
            },
          },
        },
      },
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "missing-model",
      },
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith("Download failed: disk full");
    expect(result.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen2.5-coder:7b",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("normalizes ollama/ prefix in non-interactive custom model download", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ models: [] }))
      .mockResolvedValueOnce(new Response('{"status":"success"}\n', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "ollama/llama3.2:latest",
      },
      runtime,
    });

    const pullRequest = fetchMock.mock.calls[1]?.[1];
    expect(JSON.parse(String(pullRequest?.body))).toEqual({ name: "llama3.2:latest" });
    expect(result.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "ollama/llama3.2:latest" }),
    );
  });

  it("accepts cloud models in non-interactive mode without pulling", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ models: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;

    const result = await configureOllamaNonInteractive({
      nextConfig: {},
      opts: {
        customBaseUrl: "http://127.0.0.1:11434",
        customModelId: "kimi-k2.5:cloud",
      },
      runtime,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.models?.providers?.ollama?.models?.map((model) => model.id)).toContain(
      "kimi-k2.5:cloud",
    );
    expect(result.agents?.defaults?.model).toEqual(
      expect.objectContaining({ primary: "ollama/kimi-k2.5:cloud" }),
    );
  });

  it("exits when Ollama is unreachable", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } as unknown as RuntimeEnv;
    const nextConfig = {};

    const result = await configureOllamaNonInteractive({
      nextConfig,
      opts: {
        customBaseUrl: "http://127.0.0.1:11435",
        customModelId: "llama3.2:latest",
      },
      runtime,
    });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Ollama could not be reached at http://127.0.0.1:11435."),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(result).toBe(nextConfig);
  });
});
