import fs from "node:fs/promises";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL } from "./google-gemini-model-default.js";
import {
  MINIMAX_CN_API_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
} from "./onboard-auth.js";
import type { AuthChoice } from "./onboard-types.js";
import {
  authProfilePathForAgent,
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

type DetectZaiEndpoint = typeof import("./zai-endpoint-detect.js").detectZaiEndpoint;

vi.mock("../providers/github-copilot-auth.js", () => ({
  githubCopilotLoginCommand: vi.fn(async () => {}),
}));

const loginOpenAICodexOAuth = vi.hoisted(() =>
  vi.fn<() => Promise<OAuthCredentials | null>>(async () => null),
);
vi.mock("./openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

const detectZaiEndpoint = vi.hoisted(() => vi.fn<DetectZaiEndpoint>(async () => null));
vi.mock("./zai-endpoint-detect.js", () => ({
  detectZaiEndpoint,
}));

type StoredAuthProfile = {
  key?: string;
  access?: string;
  refresh?: string;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
};

describe("applyAuthChoice", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "LITELLM_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "MOONSHOT_API_KEY",
    "MISTRAL_API_KEY",
    "KIMI_API_KEY",
    "GEMINI_API_KEY",
    "XIAOMI_API_KEY",
    "VENICE_API_KEY",
    "OPENCODE_API_KEY",
    "TOGETHER_API_KEY",
    "QIANFAN_API_KEY",
    "SYNTHETIC_API_KEY",
    "SSH_TTY",
    "CHUTES_CLIENT_ID",
  ]);
  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-auth-");
    lifecycle.setStateDir(env.stateDir);
  }
  function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
    return createWizardPrompter(overrides, { defaultSelect: "" });
  }
  function createSelectFirstOption(): WizardPrompter["select"] {
    return vi.fn(async (params) => params.options[0]?.value as never);
  }
  function createNoopMultiselect(): WizardPrompter["multiselect"] {
    return vi.fn(async () => []);
  }
  function createApiKeyPromptHarness(
    overrides: Partial<Pick<WizardPrompter, "select" | "multiselect" | "text" | "confirm">> = {},
  ): {
    select: WizardPrompter["select"];
    multiselect: WizardPrompter["multiselect"];
    prompter: WizardPrompter;
    runtime: ReturnType<typeof createExitThrowingRuntime>;
  } {
    const select = overrides.select ?? createSelectFirstOption();
    const multiselect = overrides.multiselect ?? createNoopMultiselect();
    return {
      select,
      multiselect,
      prompter: createPrompter({ ...overrides, select, multiselect }),
      runtime: createExitThrowingRuntime(),
    };
  }
  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, StoredAuthProfile>;
    }>(requireOpenClawAgentDir());
  }
  async function readAuthProfile(profileId: string) {
    return (await readAuthProfiles()).profiles?.[profileId];
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    resolvePluginProviders.mockReset();
    detectZaiEndpoint.mockReset();
    detectZaiEndpoint.mockResolvedValue(null);
    loginOpenAICodexOAuth.mockReset();
    loginOpenAICodexOAuth.mockResolvedValue(null);
    await lifecycle.cleanup();
  });

  it("does not throw when openai-codex oauth fails", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockRejectedValueOnce(new Error("oauth failed"));

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    await expect(
      applyAuthChoice({
        authChoice: "openai-codex",
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      }),
    ).resolves.toEqual({ config: {} });
  });

  it("stores openai-codex OAuth with email profile id", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockResolvedValueOnce({
      email: "user@example.com",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(result.config.auth?.profiles?.["openai-codex:user@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });
    expect(result.config.auth?.profiles?.["openai-codex:default"]).toBeUndefined();
    expect(await readAuthProfile("openai-codex:user@example.com")).toMatchObject({
      type: "oauth",
      provider: "openai-codex",
      refresh: "refresh-token",
      access: "access-token",
      email: "user@example.com",
    });
  });

  it("prompts and writes MiniMax API key when selecting minimax-api", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-minimax-test");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "minimax-api",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax API key" }),
    );
    expect(result.config.auth?.profiles?.["minimax:default"]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });

    expect((await readAuthProfile("minimax:default"))?.key).toBe("sk-minimax-test");
  });

  it("prompts and writes MiniMax API key when selecting minimax-api-key-cn", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-minimax-test");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "minimax-api-key-cn",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax China API key" }),
    );
    expect(result.config.auth?.profiles?.["minimax-cn:default"]).toMatchObject({
      provider: "minimax-cn",
      mode: "api_key",
    });
    expect(result.config.models?.providers?.["minimax-cn"]?.baseUrl).toBe(MINIMAX_CN_API_BASE_URL);

    expect((await readAuthProfile("minimax-cn:default"))?.key).toBe("sk-minimax-test");
  });

  it("prompts and writes Synthetic API key when selecting synthetic-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-synthetic-test");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "synthetic-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter Synthetic API key" }),
    );
    expect(result.config.auth?.profiles?.["synthetic:default"]).toMatchObject({
      provider: "synthetic",
      mode: "api_key",
    });

    expect((await readAuthProfile("synthetic:default"))?.key).toBe("sk-synthetic-test");
  });

  it("prompts and writes Hugging Face API key when selecting huggingface-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("hf-test-token");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "huggingface-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Hugging Face") }),
    );
    expect(result.config.auth?.profiles?.["huggingface:default"]).toMatchObject({
      provider: "huggingface",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^huggingface\/.+/);

    expect((await readAuthProfile("huggingface:default"))?.key).toBe("hf-test-token");
  });

  it("prompts for Z.AI endpoint when selecting zai-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("zai-test-key");
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "Select Z.AI endpoint") {
        return "coding-cn";
      }
      return "default";
    });
    const { prompter, runtime } = createApiKeyPromptHarness({
      select: select as WizardPrompter["select"],
      text,
    });

    const result = await applyAuthChoice({
      authChoice: "zai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select Z.AI endpoint", initialValue: "global" }),
    );
    expect(result.config.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
    expect(result.config.agents?.defaults?.model?.primary).toBe("zai/glm-5");

    expect((await readAuthProfile("zai:default"))?.key).toBe("zai-test-key");
  });

  it("uses endpoint-specific auth choice without prompting for Z.AI endpoint", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("zai-test-key");
    const select = vi.fn(async () => "default");
    const { prompter, runtime } = createApiKeyPromptHarness({
      select: select as WizardPrompter["select"],
      text,
    });

    const result = await applyAuthChoice({
      authChoice: "zai-coding-global",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select Z.AI endpoint" }),
    );
    expect(result.config.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
  });

  it("uses detected Z.AI endpoint without prompting for endpoint selection", async () => {
    await setupTempState();
    detectZaiEndpoint.mockResolvedValueOnce({
      endpoint: "coding-global",
      modelId: "glm-4.5",
      baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
      note: "Detected coding-global endpoint",
    });

    const text = vi.fn().mockResolvedValue("zai-detected-key");
    const select = vi.fn(async () => "default");
    const { prompter, runtime } = createApiKeyPromptHarness({
      select: select as WizardPrompter["select"],
      text,
    });

    const result = await applyAuthChoice({
      authChoice: "zai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(detectZaiEndpoint).toHaveBeenCalledWith({ apiKey: "zai-detected-key" });
    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select Z.AI endpoint" }),
    );
    expect(result.config.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
    expect(result.config.agents?.defaults?.model?.primary).toBe("zai/glm-4.5");
  });

  it("maps apiKey + tokenProvider=huggingface to huggingface-api-key flow", async () => {
    await setupTempState();
    delete process.env.HF_TOKEN;
    delete process.env.HUGGINGFACE_HUB_TOKEN;

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "huggingface",
        token: "hf-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["huggingface:default"]).toMatchObject({
      provider: "huggingface",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^huggingface\/.+/);
    expect(text).not.toHaveBeenCalled();

    expect((await readAuthProfile("huggingface:default"))?.key).toBe("hf-token-provider-test");
  });

  it("maps apiKey + tokenProvider=together to together-api-key flow", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "  ToGeThEr  ",
        token: "sk-together-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["together:default"]).toMatchObject({
      provider: "together",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^together\/.+/);
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect((await readAuthProfile("together:default"))?.key).toBe(
      "sk-together-token-provider-test",
    );
  });

  it("maps apiKey + tokenProvider=KIMI-CODING (case-insensitive) to kimi-code-api-key flow", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "KIMI-CODING",
        token: "sk-kimi-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["kimi-coding:default"]).toMatchObject({
      provider: "kimi-coding",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^kimi-coding\/.+/);
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect((await readAuthProfile("kimi-coding:default"))?.key).toBe("sk-kimi-token-provider-test");
  });

  it("maps apiKey + tokenProvider= GOOGLE  (case-insensitive/trimmed) to gemini-api-key flow", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: " GOOGLE  ",
        token: "sk-gemini-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["google:default"]).toMatchObject({
      provider: "google",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(GOOGLE_GEMINI_DEFAULT_MODEL);
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect((await readAuthProfile("google:default"))?.key).toBe("sk-gemini-token-provider-test");
  });

  it("maps apiKey + tokenProvider= LITELLM  (case-insensitive/trimmed) to litellm-api-key flow", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: " LITELLM  ",
        token: "sk-litellm-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["litellm:default"]).toMatchObject({
      provider: "litellm",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^litellm\/.+/);
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect((await readAuthProfile("litellm:default"))?.key).toBe("sk-litellm-token-provider-test");
  });

  it.each([
    {
      authChoice: "moonshot-api-key",
      tokenProvider: "moonshot",
      profileId: "moonshot:default",
      provider: "moonshot",
      modelPrefix: "moonshot/",
    },
    {
      authChoice: "mistral-api-key",
      tokenProvider: "mistral",
      profileId: "mistral:default",
      provider: "mistral",
      modelPrefix: "mistral/",
    },
    {
      authChoice: "kimi-code-api-key",
      tokenProvider: "kimi-code",
      profileId: "kimi-coding:default",
      provider: "kimi-coding",
      modelPrefix: "kimi-coding/",
    },
    {
      authChoice: "xiaomi-api-key",
      tokenProvider: "xiaomi",
      profileId: "xiaomi:default",
      provider: "xiaomi",
      modelPrefix: "xiaomi/",
    },
    {
      authChoice: "venice-api-key",
      tokenProvider: "venice",
      profileId: "venice:default",
      provider: "venice",
      modelPrefix: "venice/",
    },
    {
      authChoice: "opencode-zen",
      tokenProvider: "opencode",
      profileId: "opencode:default",
      provider: "opencode",
      modelPrefix: "opencode/",
    },
    {
      authChoice: "together-api-key",
      tokenProvider: "together",
      profileId: "together:default",
      provider: "together",
      modelPrefix: "together/",
    },
    {
      authChoice: "qianfan-api-key",
      tokenProvider: "qianfan",
      profileId: "qianfan:default",
      provider: "qianfan",
      modelPrefix: "qianfan/",
    },
    {
      authChoice: "synthetic-api-key",
      tokenProvider: "synthetic",
      profileId: "synthetic:default",
      provider: "synthetic",
      modelPrefix: "synthetic/",
    },
  ] as const)(
    "uses opts token for $authChoice without prompting",
    async ({ authChoice, tokenProvider, profileId, provider, modelPrefix }) => {
      await setupTempState();

      const text = vi.fn();
      const confirm = vi.fn(async () => false);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });
      const token = `sk-${tokenProvider}-test`;

      const result = await applyAuthChoice({
        authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: {
          tokenProvider,
          token,
        },
      });

      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(result.config.auth?.profiles?.[profileId]).toMatchObject({
        provider,
        mode: "api_key",
      });
      expect(result.config.agents?.defaults?.model?.primary?.startsWith(modelPrefix)).toBe(true);
      expect((await readAuthProfile(profileId))?.key).toBe(token);
    },
  );

  it("uses opts token for Gemini and keeps global default model when setDefaultModel=false", async () => {
    await setupTempState();

    const text = vi.fn();
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "gemini-api-key",
      config: { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } },
      prompter,
      runtime,
      setDefaultModel: false,
      opts: {
        tokenProvider: "google",
        token: "sk-gemini-test",
      },
    });

    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["google:default"]).toMatchObject({
      provider: "google",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("openai/gpt-4o-mini");
    expect(result.agentModelOverride).toBe(GOOGLE_GEMINI_DEFAULT_MODEL);
    expect((await readAuthProfile("google:default"))?.key).toBe("sk-gemini-test");
  });

  it("prompts for Venice API key and shows the Venice note when no token is provided", async () => {
    await setupTempState();
    process.env.VENICE_API_KEY = "";

    const note = vi.fn(async () => {});
    const text = vi.fn(async () => "sk-venice-manual");
    const prompter = createPrompter({ note, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "venice-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("privacy-focused inference"),
      "Venice AI",
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Enter Venice AI API key",
      }),
    );
    expect(result.config.auth?.profiles?.["venice:default"]).toMatchObject({
      provider: "venice",
      mode: "api_key",
    });
    expect((await readAuthProfile("venice:default"))?.key).toBe("sk-venice-manual");
  });

  it("uses existing SYNTHETIC_API_KEY when selecting synthetic-api-key", async () => {
    await setupTempState();
    process.env.SYNTHETIC_API_KEY = "sk-synthetic-env";

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "synthetic-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("SYNTHETIC_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["synthetic:default"]).toMatchObject({
      provider: "synthetic",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^synthetic\/.+/);

    expect((await readAuthProfile("synthetic:default"))?.key).toBe("sk-synthetic-env");
  });

  it("does not override the global default model when selecting xai-api-key without setDefaultModel", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-xai-test");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "xai-api-key",
      config: { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } },
      prompter,
      runtime,
      setDefaultModel: false,
      agentId: "agent-1",
    });

    expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: "Enter xAI API key" }));
    expect(result.config.auth?.profiles?.["xai:default"]).toMatchObject({
      provider: "xai",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("openai/gpt-4o-mini");
    expect(result.agentModelOverride).toBe("xai/grok-4");

    expect((await readAuthProfile("xai:default"))?.key).toBe("sk-xai-test");
  });

  it("sets default model when selecting github-copilot", async () => {
    await setupTempState();

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    try {
      const result = await applyAuthChoice({
        authChoice: "github-copilot",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.agents?.defaults?.model?.primary).toBe("github-copilot/gpt-4o");
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
  });

  it("does not override the default model when selecting opencode-zen without setDefaultModel", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-opencode-zen-test");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "opencode-zen",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter OpenCode Zen API key" }),
    );
    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(result.config.models?.providers?.["opencode-zen"]).toBeUndefined();
    expect(result.agentModelOverride).toBe("opencode/claude-opus-4-6");
  });

  it("does not persist literal 'undefined' when API key prompts return undefined", async () => {
    const scenarios = [
      {
        authChoice: "apiKey" as const,
        envKey: "ANTHROPIC_API_KEY",
        profileId: "anthropic:default",
        provider: "anthropic",
      },
      {
        authChoice: "openrouter-api-key" as const,
        envKey: "OPENROUTER_API_KEY",
        profileId: "openrouter:default",
        provider: "openrouter",
      },
    ];

    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env[scenario.envKey];

      const text = vi.fn(async () => undefined as unknown as string);
      const prompter = createPrompter({ text });
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });

      const profile = await readAuthProfile(scenario.profileId);
      expect(profile?.key).toBe("");
      expect(profile?.key).not.toBe("undefined");
    }
  });

  it("uses existing OPENROUTER_API_KEY when selecting openrouter-api-key", async () => {
    await setupTempState();
    process.env.OPENROUTER_API_KEY = "sk-openrouter-test";

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "openrouter-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENROUTER_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("openrouter/auto");

    expect((await readAuthProfile("openrouter:default"))?.key).toBe("sk-openrouter-test");

    delete process.env.OPENROUTER_API_KEY;
  });

  it("ignores legacy LiteLLM oauth profiles when selecting litellm-api-key", async () => {
    await setupTempState();
    process.env.LITELLM_API_KEY = "sk-litellm-test";

    const authProfilePath = authProfilePathForAgent(requireOpenClawAgentDir());
    await fs.writeFile(
      authProfilePath,
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "litellm:legacy": {
              type: "oauth",
              provider: "litellm",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "litellm-api-key",
      config: {
        auth: {
          profiles: {
            "litellm:legacy": { provider: "litellm", mode: "oauth" },
          },
          order: { litellm: ["litellm:legacy"] },
        },
      },
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("LITELLM_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["litellm:default"]).toMatchObject({
      provider: "litellm",
      mode: "api_key",
    });

    expect(await readAuthProfile("litellm:default")).toMatchObject({
      type: "api_key",
      key: "sk-litellm-test",
    });
  });

  it("uses existing AI_GATEWAY_API_KEY when selecting ai-gateway-api-key", async () => {
    await setupTempState();
    process.env.AI_GATEWAY_API_KEY = "gateway-test-key";

    const text = vi.fn();
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "ai-gateway-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("AI_GATEWAY_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["vercel-ai-gateway:default"]).toMatchObject({
      provider: "vercel-ai-gateway",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "vercel-ai-gateway/anthropic/claude-opus-4.6",
    );

    expect((await readAuthProfile("vercel-ai-gateway:default"))?.key).toBe("gateway-test-key");

    delete process.env.AI_GATEWAY_API_KEY;
  });

  it("uses existing CLOUDFLARE_AI_GATEWAY_API_KEY when selecting cloudflare-ai-gateway-api-key", async () => {
    await setupTempState();
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-gateway-test-key";

    const text = vi
      .fn()
      .mockResolvedValueOnce("cf-account-id")
      .mockResolvedValueOnce("cf-gateway-id");
    const confirm = vi.fn(async () => true);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "cloudflare-ai-gateway-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_API_KEY"),
      }),
    );
    expect(text).toHaveBeenCalledTimes(2);
    expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
      provider: "cloudflare-ai-gateway",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "cloudflare-ai-gateway/claude-sonnet-4-5",
    );

    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.key).toBe(
      "cf-gateway-test-key",
    );
    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.metadata).toEqual({
      accountId: "cf-account-id",
      gatewayId: "cf-gateway-id",
    });

    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  });

  it("uses explicit Cloudflare account/gateway/api key opts without extra prompts", async () => {
    await setupTempState();

    const text = vi.fn();
    const confirm = vi.fn(async () => false);
    const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

    const result = await applyAuthChoice({
      authChoice: "cloudflare-ai-gateway-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        cloudflareAiGatewayAccountId: "acc-direct",
        cloudflareAiGatewayGatewayId: "gw-direct",
        cloudflareAiGatewayApiKey: "cf-direct-key",
      },
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
      provider: "cloudflare-ai-gateway",
      mode: "api_key",
    });
    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.key).toBe("cf-direct-key");
    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.metadata).toEqual({
      accountId: "acc-direct",
      gatewayId: "gw-direct",
    });
  });

  it("writes Chutes OAuth credentials when selecting chutes (remote/manual)", async () => {
    await setupTempState();
    process.env.SSH_TTY = "1";
    process.env.CHUTES_CLIENT_ID = "cid_test";

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          JSON.stringify({
            access_token: "at_test",
            refresh_token: "rt_test",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ username: "remote-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const runtime = createExitThrowingRuntime();
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Paste the redirect URL") {
        const runtimeLog = runtime.log as ReturnType<typeof vi.fn>;
        const lastLog = runtimeLog.mock.calls.at(-1)?.[0];
        const urlLine = typeof lastLog === "string" ? lastLog : String(lastLog ?? "");
        const urlMatch = urlLine.match(/https?:\/\/\S+/)?.[0] ?? "";
        const state = urlMatch ? new URL(urlMatch).searchParams.get("state") : null;
        if (!state) {
          throw new Error("missing state in oauth URL");
        }
        return `?code=code_manual&state=${state}`;
      }
      return "code_manual";
    });
    const { prompter } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "chutes",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Paste the redirect URL",
      }),
    );
    expect(result.config.auth?.profiles?.["chutes:remote-user"]).toMatchObject({
      provider: "chutes",
      mode: "oauth",
    });

    expect(await readAuthProfile("chutes:remote-user")).toMatchObject({
      provider: "chutes",
      access: "at_test",
      refresh: "rt_test",
      email: "remote-user",
    });
  });

  it("writes Qwen credentials when selecting qwen-portal", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "qwen-portal",
        label: "Qwen",
        auth: [
          {
            id: "device",
            label: "Qwen OAuth",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "qwen-portal:default",
                  credential: {
                    type: "oauth",
                    provider: "qwen-portal",
                    access: "access",
                    refresh: "refresh",
                    expires: Date.now() + 60 * 60 * 1000,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "qwen-portal": {
                      baseUrl: "https://portal.qwen.ai/v1",
                      apiKey: "qwen-oauth",
                      api: "openai-completions",
                      models: [],
                    },
                  },
                },
              },
              defaultModel: "qwen-portal/coder-model",
            })),
          },
        ],
      },
    ] as never);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "qwen-portal",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["qwen-portal:default"]).toMatchObject({
      provider: "qwen-portal",
      mode: "oauth",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("qwen-portal/coder-model");
    expect(result.config.models?.providers?.["qwen-portal"]).toMatchObject({
      baseUrl: "https://portal.qwen.ai/v1",
      apiKey: "qwen-oauth",
    });

    expect(await readAuthProfile("qwen-portal:default")).toMatchObject({
      provider: "qwen-portal",
      access: "access",
      refresh: "refresh",
    });
  });

  it("writes MiniMax credentials when selecting minimax-portal", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "minimax-portal",
        label: "MiniMax",
        auth: [
          {
            id: "oauth",
            label: "MiniMax OAuth (Global)",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "minimax-portal:default",
                  credential: {
                    type: "oauth",
                    provider: "minimax-portal",
                    access: "access",
                    refresh: "refresh",
                    expires: Date.now() + 60 * 60 * 1000,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "minimax-portal": {
                      baseUrl: "https://api.minimax.io/anthropic",
                      apiKey: "minimax-oauth",
                      api: "anthropic-messages",
                      models: [],
                    },
                  },
                },
              },
              defaultModel: "minimax-portal/MiniMax-M2.1",
            })),
          },
        ],
      },
    ] as never);

    const prompter = createPrompter({
      select: vi.fn(async () => "oauth" as never) as WizardPrompter["select"],
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "minimax-portal",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["minimax-portal:default"]).toMatchObject({
      provider: "minimax-portal",
      mode: "oauth",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("minimax-portal/MiniMax-M2.1");
    expect(result.config.models?.providers?.["minimax-portal"]).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      apiKey: "minimax-oauth",
    });

    expect(await readAuthProfile("minimax-portal:default")).toMatchObject({
      provider: "minimax-portal",
      access: "access",
      refresh: "refresh",
    });
  });
});

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps github-copilot to the provider", () => {
    expect(resolvePreferredProviderForAuthChoice("github-copilot")).toBe("github-copilot");
  });

  it("maps qwen-portal to the provider", () => {
    expect(resolvePreferredProviderForAuthChoice("qwen-portal")).toBe("qwen-portal");
  });

  it("maps mistral-api-key to the provider", () => {
    expect(resolvePreferredProviderForAuthChoice("mistral-api-key")).toBe("mistral");
  });

  it("returns undefined for unknown choices", () => {
    expect(resolvePreferredProviderForAuthChoice("unknown" as AuthChoice)).toBeUndefined();
  });
});
