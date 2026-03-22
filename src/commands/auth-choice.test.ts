import fs from "node:fs/promises";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicPlugin from "../../extensions/anthropic/index.js";
import chutesPlugin from "../../extensions/chutes/index.js";
import cloudflareAiGatewayPlugin from "../../extensions/cloudflare-ai-gateway/index.js";
import googlePlugin from "../../extensions/google/index.js";
import huggingfacePlugin from "../../extensions/huggingface/index.js";
import kimiCodingPlugin from "../../extensions/kimi-coding/index.js";
import minimaxPlugin from "../../extensions/minimax/index.js";
import mistralPlugin from "../../extensions/mistral/index.js";
import moonshotPlugin from "../../extensions/moonshot/index.js";
import ollamaPlugin from "../../extensions/ollama/index.js";
import openAIPlugin from "../../extensions/openai/index.js";
import opencodeGoPlugin from "../../extensions/opencode-go/index.js";
import opencodePlugin from "../../extensions/opencode/index.js";
import openrouterPlugin from "../../extensions/openrouter/index.js";
import qianfanPlugin from "../../extensions/qianfan/index.js";
import qwenPortalAuthPlugin from "../../extensions/qwen-portal-auth/index.js";
import syntheticPlugin from "../../extensions/synthetic/index.js";
import togetherPlugin from "../../extensions/together/index.js";
import venicePlugin from "../../extensions/venice/index.js";
import vercelAiGatewayPlugin from "../../extensions/vercel-ai-gateway/index.js";
import xaiPlugin from "../../extensions/xai/index.js";
import xiaomiPlugin from "../../extensions/xiaomi/index.js";
import { setDetectZaiEndpointForTesting } from "../../extensions/zai/detect.js";
import zaiPlugin from "../../extensions/zai/index.js";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  MINIMAX_CN_API_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
} from "../plugins/provider-model-definitions.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { registerProviderPlugins } from "../test-utils/plugin-registration.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import { GOOGLE_GEMINI_DEFAULT_MODEL } from "./google-gemini-model-default.js";
import { GIGACHAT_BASE_URL } from "./onboard-auth.models.js";
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

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

const detectZaiEndpoint = vi.hoisted(() => vi.fn<DetectZaiEndpoint>(async () => null));
vi.mock("./zai-endpoint-detect.js", () => ({
  detectZaiEndpoint,
}));

type StoredAuthProfile = {
  key?: string;
  keyRef?: { source: string; provider: string; id: string };
  access?: string;
  refresh?: string;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
};

function createDefaultProviderPlugins() {
  return registerProviderPlugins(
    anthropicPlugin,
    chutesPlugin,
    cloudflareAiGatewayPlugin,
    googlePlugin,
    huggingfacePlugin,
    kimiCodingPlugin,
    minimaxPlugin,
    mistralPlugin,
    moonshotPlugin,
    ollamaPlugin,
    openAIPlugin,
    opencodeGoPlugin,
    opencodePlugin,
    openrouterPlugin,
    qianfanPlugin,
    qwenPortalAuthPlugin,
    syntheticPlugin,
    togetherPlugin,
    venicePlugin,
    vercelAiGatewayPlugin,
    xaiPlugin,
    xiaomiPlugin,
    zaiPlugin,
  );
}

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
  let activeStateDir: string | null = null;
  async function setupTempState() {
    if (activeStateDir) {
      await fs.rm(activeStateDir, { recursive: true, force: true });
    }
    const env = await setupAuthTestEnv("openclaw-auth-");
    activeStateDir = env.stateDir;
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
    resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());
    detectZaiEndpoint.mockReset();
    detectZaiEndpoint.mockResolvedValue(null);
    setDetectZaiEndpointForTesting(detectZaiEndpoint);
    loginOpenAICodexOAuth.mockReset();
    loginOpenAICodexOAuth.mockResolvedValue(null);
    await lifecycle.cleanup();
    activeStateDir = null;
  });

  setDetectZaiEndpointForTesting(detectZaiEndpoint);
  resolvePluginProviders.mockReturnValue(createDefaultProviderPlugins());

  it("does not throw when openai-codex oauth fails", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockRejectedValueOnce(new Error("oauth failed"));
    resolvePluginProviders.mockReturnValue([
      {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [
          {
            id: "oauth",
            label: "ChatGPT OAuth",
            kind: "oauth",
            run: vi.fn(async () => {
              try {
                await loginOpenAICodexOAuth();
              } catch {
                return { profiles: [] };
              }
              return { profiles: [] };
            }),
          },
        ],
      },
    ] as never);

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
    resolvePluginProviders.mockReturnValue([
      {
        id: "openai-codex",
        label: "OpenAI Codex",
        auth: [
          {
            id: "oauth",
            label: "ChatGPT OAuth",
            kind: "oauth",
            run: vi.fn(async () => {
              const creds = await loginOpenAICodexOAuth();
              if (!creds) {
                return { profiles: [] };
              }
              return {
                profiles: [
                  {
                    profileId: "openai-codex:user@example.com",
                    credential: {
                      type: "oauth",
                      provider: "openai-codex",
                      refresh: "refresh-token",
                      access: "access-token",
                      expires: creds.expires,
                      email: "user@example.com",
                    },
                  },
                ],
                defaultModel: "openai-codex/gpt-5.4",
              };
            }),
          },
        ],
      },
    ] as never);

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

  it("persists GigaChat Basic credentials even when secret-input-mode is ref", async () => {
    await setupTempState();

    process.env.GIGACHAT_CREDENTIALS = "env-oauth-credentials"; // pragma: allowlist secret
    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;

    const text = vi
      .fn()
      .mockResolvedValueOnce("https://gigachat.ift.sberdevices.ru/v1")
      .mockResolvedValueOnce("basic-user")
      .mockResolvedValueOnce("basic-pass");
    const { prompter, runtime } = createApiKeyPromptHarness({ text });

    const result = await applyAuthChoice({
      authChoice: "gigachat-basic",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
      opts: { secretInputMode: "ref" },
    });

    expect(result.config.auth?.profiles?.["gigachat:default"]).toMatchObject({
      provider: "gigachat",
      mode: "api_key",
    });
    expect(result.agentModelOverride).toBe("gigachat/GigaChat-2-Max");
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBeUndefined();
    expect(await readAuthProfile("gigachat:default")).toMatchObject({
      type: "api_key",
      provider: "gigachat",
      key: "basic-user:basic-pass",
      metadata: {
        authMode: "basic",
        scope: "GIGACHAT_API_PERS",
      },
    });
    expect((await readAuthProfile("gigachat:default"))?.metadata).not.toHaveProperty("insecureTls");
    expect((await readAuthProfile("gigachat:default"))?.keyRef).toBeUndefined();
  });

  it("captures business scope for direct GigaChat Basic onboarding", async () => {
    await setupTempState();

    process.env.GIGACHAT_CREDENTIALS = "env-oauth-credentials"; // pragma: allowlist secret
    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;

    const select: WizardPrompter["select"] = vi.fn(async () => "GIGACHAT_API_B2B" as never);
    const text = vi
      .fn()
      .mockResolvedValueOnce("https://gigachat.ift.sberdevices.ru/v1")
      .mockResolvedValueOnce("basic-user")
      .mockResolvedValueOnce("basic-pass");
    const { prompter, runtime } = createApiKeyPromptHarness({ select, text });

    await applyAuthChoice({
      authChoice: "gigachat-basic",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(await readAuthProfile("gigachat:default")).toMatchObject({
      metadata: {
        authMode: "basic",
        scope: "GIGACHAT_API_B2B",
      },
    });
  });

  it("rejects Basic-shaped GigaChat credentials on the interactive OAuth path", async () => {
    await setupTempState();

    process.env.GIGACHAT_CREDENTIALS = "basic-user:basic-pass"; // pragma: allowlist secret
    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;

    const { prompter } = createApiKeyPromptHarness({
      confirm: vi.fn(async () => true),
    });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit ${code}`);
      }),
    };

    await expect(
      applyAuthChoice({
        authChoice: "gigachat-personal",
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      }),
    ).rejects.toThrow("exit 1");

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Basic user:password credentials"),
    );
    await expect(readAuthProfile("gigachat:default")).rejects.toThrow();
  });

  it("accepts OAuth GigaChat credentials keys that contain colons", async () => {
    await setupTempState();

    delete process.env.GIGACHAT_CREDENTIALS;
    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;

    const { prompter, runtime } = createApiKeyPromptHarness();

    const result = await applyAuthChoice({
      authChoice: "gigachat-personal",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
      opts: { gigachatApiKey: "oauth:credential:with:colon" },
    });

    expect(result.config.auth?.profiles?.["gigachat:default"]).toMatchObject({
      provider: "gigachat",
      mode: "api_key",
    });
    const profile = await readAuthProfile("gigachat:default");
    expect(profile).toMatchObject({
      type: "api_key",
      provider: "gigachat",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    });
    expect(profile?.metadata).not.toHaveProperty("insecureTls");
  });

  it("resets a custom Basic GigaChat base URL when switching to OAuth", async () => {
    await setupTempState();

    delete process.env.GIGACHAT_CREDENTIALS;
    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;

    const basicText = vi
      .fn()
      .mockResolvedValueOnce("https://preview-basic.gigachat.example/api/v1")
      .mockResolvedValueOnce("basic-user")
      .mockResolvedValueOnce("basic-pass");
    const basicHarness = createApiKeyPromptHarness({ text: basicText });

    const basicResult = await applyAuthChoice({
      authChoice: "gigachat-basic",
      config: {},
      prompter: basicHarness.prompter,
      runtime: basicHarness.runtime,
      setDefaultModel: true,
    });

    expect(basicResult.config.models?.providers?.gigachat?.baseUrl).toBe(
      "https://preview-basic.gigachat.example/api/v1",
    );

    process.env.GIGACHAT_CREDENTIALS = "gigachat-oauth-credentials=="; // pragma: allowlist secret
    const oauthHarness = createApiKeyPromptHarness();

    const oauthResult = await applyAuthChoice({
      authChoice: "gigachat-personal",
      config: basicResult.config,
      prompter: oauthHarness.prompter,
      runtime: oauthHarness.runtime,
      setDefaultModel: true,
    });

    expect(oauthResult.config.models?.providers?.gigachat?.baseUrl).toBe(GIGACHAT_BASE_URL);
    expect(await readAuthProfile("gigachat:default")).toMatchObject({
      type: "api_key",
      provider: "gigachat",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    });
  });

  it("resets a custom Basic GigaChat base URL when the active ordered profile is non-default", async () => {
    await setupTempState();

    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;
    process.env.GIGACHAT_CREDENTIALS = "gigachat-oauth-credentials=="; // pragma: allowlist secret

    await fs.writeFile(
      authProfilePathForAgent(requireOpenClawAgentDir()),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "gigachat:work": {
              type: "api_key",
              provider: "gigachat",
              key: "basic-user:basic-pass",
              metadata: { authMode: "basic" },
            },
            "gigachat:default": {
              type: "api_key",
              provider: "gigachat",
              key: "gigachat-oauth-credentials==", // pragma: allowlist secret
              metadata: {
                authMode: "oauth",
                scope: "GIGACHAT_API_PERS",
              },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const oauthHarness = createApiKeyPromptHarness();
    const oauthResult = await applyAuthChoice({
      authChoice: "gigachat-personal",
      config: {
        auth: {
          profiles: {
            "gigachat:work": { provider: "gigachat", mode: "api_key" },
            "gigachat:default": { provider: "gigachat", mode: "api_key" },
          },
          order: { gigachat: ["gigachat:work", "gigachat:default"] },
        },
        models: {
          providers: {
            gigachat: {
              baseUrl: "https://preview-basic.gigachat.example/api/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      prompter: oauthHarness.prompter,
      runtime: oauthHarness.runtime,
      setDefaultModel: true,
    });

    expect(oauthResult.config.models?.providers?.gigachat?.baseUrl).toBe(GIGACHAT_BASE_URL);
  });

  it("resets a config-backed Basic GigaChat base URL when switching to OAuth", async () => {
    await setupTempState();

    delete process.env.GIGACHAT_USER;
    delete process.env.GIGACHAT_PASSWORD;
    delete process.env.GIGACHAT_BASE_URL;
    process.env.GIGACHAT_CREDENTIALS = "gigachat-oauth-credentials=="; // pragma: allowlist secret

    const oauthHarness = createApiKeyPromptHarness();
    const oauthResult = await applyAuthChoice({
      authChoice: "gigachat-personal",
      config: {
        models: {
          providers: {
            gigachat: {
              api: "openai-completions",
              apiKey: "basic-user:basic-pass",
              baseUrl: "https://preview-basic.gigachat.example/api/v1",
              models: [],
            },
          },
        },
      },
      prompter: oauthHarness.prompter,
      runtime: oauthHarness.runtime,
      setDefaultModel: true,
    });

    expect(oauthResult.config.models?.providers?.gigachat?.baseUrl).toBe(GIGACHAT_BASE_URL);
    expect(await readAuthProfile("gigachat:default")).toMatchObject({
      type: "api_key",
      provider: "gigachat",
      metadata: {
        authMode: "oauth",
        scope: "GIGACHAT_API_PERS",
      },
    });
  });

  it("prompts and writes provider API key for common providers", async () => {
    const scenarios: Array<{
      authChoice:
        | "minimax-global-api"
        | "minimax-cn-api"
        | "synthetic-api-key"
        | "huggingface-api-key";
      promptContains: string;
      profileId: string;
      provider: string;
      token: string;
      expectedBaseUrl?: string;
      expectedModelPrefix?: string;
    }> = [
      {
        authChoice: "minimax-global-api" as const,
        promptContains: "Enter MiniMax API key",
        profileId: "minimax:global",
        provider: "minimax",
        token: "sk-minimax-test",
      },
      {
        authChoice: "minimax-cn-api" as const,
        promptContains: "Enter MiniMax CN API key",
        profileId: "minimax:cn",
        provider: "minimax",
        token: "sk-minimax-test",
        expectedBaseUrl: MINIMAX_CN_API_BASE_URL,
      },
      {
        authChoice: "synthetic-api-key" as const,
        promptContains: "Enter Synthetic API key",
        profileId: "synthetic:default",
        provider: "synthetic",
        token: "sk-synthetic-test",
      },
      {
        authChoice: "huggingface-api-key" as const,
        promptContains: "Hugging Face",
        profileId: "huggingface:default",
        provider: "huggingface",
        token: "hf-test-token",
        expectedModelPrefix: "huggingface/",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining(scenario.promptContains) }),
      );
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      if (scenario.expectedBaseUrl) {
        expect(result.config.models?.providers?.[scenario.provider]?.baseUrl).toBe(
          scenario.expectedBaseUrl,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
  });

  it("handles Z.AI endpoint selection and detection paths", async () => {
    const scenarios: Array<{
      authChoice: "zai-api-key" | "zai-coding-global";
      token: string;
      endpointSelection?: "coding-cn" | "global";
      detectResult?: {
        endpoint: "coding-global" | "coding-cn";
        modelId: string;
        baseUrl: string;
        note: string;
      };
      expectedBaseUrl: string;
      expectedModel?: string;
      shouldPromptForEndpoint: boolean;
      expectedDetectCall?: { apiKey: string; endpoint?: "coding-global" | "coding-cn" };
    }> = [
      {
        authChoice: "zai-api-key",
        token: "zai-test-key",
        endpointSelection: "coding-cn",
        expectedBaseUrl: ZAI_CODING_CN_BASE_URL,
        expectedModel: "zai/glm-5",
        shouldPromptForEndpoint: true,
      },
      {
        authChoice: "zai-coding-global",
        token: "zai-test-key",
        detectResult: {
          endpoint: "coding-global",
          modelId: "glm-4.7",
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          note: "Detected coding-global endpoint with GLM-4.7 fallback",
        },
        expectedBaseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        expectedModel: "zai/glm-4.7",
        shouldPromptForEndpoint: false,
        expectedDetectCall: { apiKey: "zai-test-key", endpoint: "coding-global" },
      },
      {
        authChoice: "zai-api-key",
        token: "zai-detected-key",
        detectResult: {
          endpoint: "coding-global",
          modelId: "glm-4.5",
          baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
          note: "Detected coding-global endpoint",
        },
        expectedBaseUrl: ZAI_CODING_GLOBAL_BASE_URL,
        expectedModel: "zai/glm-4.5",
        shouldPromptForEndpoint: false,
        expectedDetectCall: { apiKey: "zai-detected-key" },
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      detectZaiEndpoint.mockReset();
      detectZaiEndpoint.mockResolvedValue(null);
      if (scenario.detectResult) {
        detectZaiEndpoint.mockResolvedValueOnce(scenario.detectResult);
      }

      const text = vi.fn().mockResolvedValue(scenario.token);
      const select = vi.fn(async (params: { message: string }) => {
        if (params.message === "Select Z.AI endpoint") {
          return scenario.endpointSelection ?? "global";
        }
        return "default";
      });
      const { prompter, runtime } = createApiKeyPromptHarness({
        select: select as WizardPrompter["select"],
        text,
      });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      if (scenario.expectedDetectCall) {
        expect(detectZaiEndpoint).toHaveBeenCalledWith(scenario.expectedDetectCall);
      }
      if (scenario.shouldPromptForEndpoint) {
        expect(select).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Select Z.AI endpoint", initialValue: "global" }),
        );
      } else {
        expect(select).not.toHaveBeenCalledWith(
          expect.objectContaining({ message: "Select Z.AI endpoint" }),
        );
      }
      expect(result.config.models?.providers?.zai?.baseUrl).toBe(scenario.expectedBaseUrl);
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.authChoice === "zai-api-key") {
        expect((await readAuthProfile("zai:default"))?.key).toBe(scenario.token);
      }
    }
  });

  it("maps apiKey tokenProvider aliases to provider flow", async () => {
    const scenarios: Array<{
      tokenProvider: string;
      token: string;
      profileId: string;
      provider: string;
      expectedModel?: string;
      expectedModelPrefix?: string;
    }> = [
      {
        tokenProvider: "huggingface",
        token: "hf-token-provider-test",
        profileId: "huggingface:default",
        provider: "huggingface",
        expectedModelPrefix: "huggingface/",
      },
      {
        tokenProvider: "  ToGeThEr  ",
        token: "sk-together-token-provider-test",
        profileId: "together:default",
        provider: "together",
        expectedModelPrefix: "together/",
      },
      {
        tokenProvider: "KIMI-CODING",
        token: "sk-kimi-token-provider-test",
        profileId: "kimi:default",
        provider: "kimi",
        expectedModelPrefix: "kimi/",
      },
      {
        tokenProvider: " GOOGLE  ",
        token: "sk-gemini-token-provider-test",
        profileId: "google:default",
        provider: "google",
        expectedModel: GOOGLE_GEMINI_DEFAULT_MODEL,
      },
      {
        tokenProvider: " LITELLM  ",
        token: "sk-litellm-token-provider-test",
        profileId: "litellm:default",
        provider: "litellm",
        expectedModelPrefix: "litellm/",
      },
    ];
    for (const scenario of scenarios) {
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
          tokenProvider: scenario.tokenProvider,
          token: scenario.token,
        },
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect((await readAuthProfile(scenario.profileId))?.key).toBe(scenario.token);
    }
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
      profileId: "kimi:default",
      provider: "kimi",
      modelPrefix: "kimi/",
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
      extraProfiles: ["opencode-go:default"],
    },
    {
      authChoice: "opencode-go",
      tokenProvider: "opencode-go",
      profileId: "opencode-go:default",
      provider: "opencode-go",
      modelPrefix: "opencode-go/",
      extraProfiles: ["opencode:default"],
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
    async ({ authChoice, tokenProvider, profileId, provider, modelPrefix, extraProfiles }) => {
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
      expect(
        resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
          modelPrefix,
        ),
      ).toBe(true);
      expect((await readAuthProfile(profileId))?.key).toBe(token);
      for (const extraProfile of extraProfiles ?? []) {
        expect((await readAuthProfile(extraProfile))?.key).toBe(token);
      }
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
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "openai/gpt-4o-mini",
    );
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

  it("uses existing env API keys for selected providers", async () => {
    const scenarios: Array<{
      authChoice: "synthetic-api-key" | "openrouter-api-key" | "ai-gateway-api-key";
      envKey: "SYNTHETIC_API_KEY" | "OPENROUTER_API_KEY" | "AI_GATEWAY_API_KEY";
      envValue: string;
      profileId: string;
      provider: string;
      opts?: { secretInputMode?: "ref" };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: "env"; provider: string; id: string };
      expectedModel?: string;
      expectedModelPrefix?: string;
    }> = [
      {
        authChoice: "synthetic-api-key",
        envKey: "SYNTHETIC_API_KEY",
        envValue: "sk-synthetic-env",
        profileId: "synthetic:default",
        provider: "synthetic",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "sk-synthetic-env",
        expectedModelPrefix: "synthetic/",
      },
      {
        authChoice: "openrouter-api-key",
        envKey: "OPENROUTER_API_KEY",
        envValue: "sk-openrouter-test",
        profileId: "openrouter:default",
        provider: "openrouter",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "sk-openrouter-test",
        expectedModel: "openrouter/auto",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-test-key",
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        expectEnvPrompt: true,
        expectedTextCalls: 0,
        expectedKey: "gateway-test-key",
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      },
      {
        authChoice: "ai-gateway-api-key",
        envKey: "AI_GATEWAY_API_KEY",
        envValue: "gateway-ref-key",
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        opts: { secretInputMode: "ref" }, // pragma: allowlist secret
        expectEnvPrompt: false,
        expectedTextCalls: 1,
        expectedKeyRef: { source: "env", provider: "default", id: "AI_GATEWAY_API_KEY" },
        expectedModel: "vercel-ai-gateway/anthropic/claude-opus-4.6",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.SYNTHETIC_API_KEY;
      delete process.env.OPENROUTER_API_KEY;
      delete process.env.AI_GATEWAY_API_KEY;
      process.env[scenario.envKey] = scenario.envValue;

      const text = vi.fn();
      const confirm = vi.fn(async () => true);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: scenario.opts,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining(scenario.envKey),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.provider,
        mode: "api_key",
      });
      if (scenario.expectedModel) {
        expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
          scenario.expectedModel,
        );
      }
      if (scenario.expectedModelPrefix) {
        expect(
          resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)?.startsWith(
            scenario.expectedModelPrefix,
          ),
        ).toBe(true);
      }
      const profile = await readAuthProfile(scenario.profileId);
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
        expect(profile?.key).toBeUndefined();
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
        expect(profile?.keyRef).toBeUndefined();
      }
    }
  });

  it("retries ref setup when provider preflight fails and can switch to env ref", async () => {
    await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

    const selectValues: Array<"provider" | "env" | "filemain"> = ["provider", "filemain", "env"];
    const select = vi.fn(async (params: Parameters<WizardPrompter["select"]>[0]) => {
      const next = selectValues[0];
      if (next && params.options.some((option) => option.value === next)) {
        selectValues.shift();
        return next as never;
      }
      return (params.options[0]?.value ?? "env") as never;
    });
    const text = vi
      .fn<WizardPrompter["text"]>()
      .mockResolvedValueOnce("/providers/openai/apiKey")
      .mockResolvedValueOnce("OPENAI_API_KEY");
    const note = vi.fn(async () => undefined);

    const prompter = createPrompter({
      select,
      text,
      note,
      confirm: vi.fn(async () => true),
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openai-api-key",
      config: {
        secrets: {
          providers: {
            filemain: {
              source: "file",
              path: "/tmp/openclaw-missing-secrets.json",
              mode: "json",
            },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
      opts: { secretInputMode: "ref" }, // pragma: allowlist secret
    });

    expect(result.config.auth?.profiles?.["openai:default"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Could not validate provider reference"),
      "Reference check failed",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Validated environment variable OPENAI_API_KEY."),
      "Reference validated",
    );
    expect(await readAuthProfile("openai:default")).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
  });

  it("keeps existing default model for explicit provider keys when setDefaultModel=false", async () => {
    const scenarios: Array<{
      authChoice: "xai-api-key" | "opencode-zen" | "opencode-go";
      token: string;
      promptMessage: string;
      existingPrimary: string;
      expectedOverride: string;
      profileId?: string;
      profileProvider?: string;
      extraProfileId?: string;
      expectProviderConfigUndefined?: "opencode" | "opencode-go" | "opencode-zen";
      agentId?: string;
    }> = [
      {
        authChoice: "xai-api-key",
        token: "sk-xai-test",
        promptMessage: "Enter xAI API key",
        existingPrimary: "openai/gpt-4o-mini",
        expectedOverride: "xai/grok-4",
        profileId: "xai:default",
        profileProvider: "xai",
        agentId: "agent-1",
      },
      {
        authChoice: "opencode-zen",
        token: "sk-opencode-zen-test",
        promptMessage: "Enter OpenCode API key",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectedOverride: "opencode/claude-opus-4-6",
        profileId: "opencode:default",
        profileProvider: "opencode",
        extraProfileId: "opencode-go:default",
        expectProviderConfigUndefined: "opencode",
      },
      {
        authChoice: "opencode-go",
        token: "sk-opencode-go-test",
        promptMessage: "Enter OpenCode API key",
        existingPrimary: "anthropic/claude-opus-4-5",
        expectedOverride: "opencode-go/kimi-k2.5",
        profileId: "opencode-go:default",
        profileProvider: "opencode-go",
        extraProfileId: "opencode:default",
        expectProviderConfigUndefined: "opencode-go",
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      const text = vi.fn().mockResolvedValue(scenario.token);
      const { prompter, runtime } = createApiKeyPromptHarness({ text });

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: { agents: { defaults: { model: { primary: scenario.existingPrimary } } } },
        prompter,
        runtime,
        setDefaultModel: false,
        agentId: scenario.agentId,
      });

      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({ message: scenario.promptMessage }),
      );
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.existingPrimary,
      );
      expect(result.agentModelOverride).toBe(scenario.expectedOverride);
      if (scenario.profileId && scenario.profileProvider) {
        expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
          provider: scenario.profileProvider,
          mode: "api_key",
        });
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.profileId]?.key).toBe(scenario.token);
      }
      if (scenario.extraProfileId) {
        const profileStore =
          scenario.agentId && scenario.agentId !== "default"
            ? await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
                resolveAgentDir(result.config, scenario.agentId),
              )
            : await readAuthProfiles();
        expect(profileStore.profiles?.[scenario.extraProfileId]?.key).toBe(scenario.token);
      }
      if (scenario.expectProviderConfigUndefined) {
        expect(
          result.config.models?.providers?.[scenario.expectProviderConfigUndefined],
        ).toBeUndefined();
      }
    }
  });

  it("sets default model when selecting github-copilot", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "github-copilot",
        label: "GitHub Copilot",
        auth: [
          {
            id: "device",
            label: "GitHub device login",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "github-copilot:github",
                  credential: {
                    type: "token",
                    provider: "github-copilot",
                    token: "github-device-token",
                  },
                },
              ],
              defaultModel: "github-copilot/gpt-4o",
            })),
          },
        ],
      },
    ] as never);

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

      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "github-copilot/gpt-4o",
      );
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete (stdin as { isTTY?: boolean }).isTTY;
      }
    }
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

  it("ignores legacy LiteLLM oauth profiles when selecting litellm-api-key", async () => {
    await setupTempState();
    process.env.LITELLM_API_KEY = "sk-litellm-test"; // pragma: allowlist secret

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

  it("configures cloudflare ai gateway via env key and explicit opts", async () => {
    const scenarios: Array<{
      envGatewayKey?: string;
      textValues: string[];
      confirmValue: boolean;
      opts?: {
        secretInputMode?: "ref"; // pragma: allowlist secret
        cloudflareAiGatewayAccountId?: string;
        cloudflareAiGatewayGatewayId?: string;
        cloudflareAiGatewayApiKey?: string;
      };
      expectEnvPrompt: boolean;
      expectedTextCalls: number;
      expectedKey?: string;
      expectedKeyRef?: { source: string; provider: string; id: string };
      expectedMetadata: { accountId: string; gatewayId: string };
    }> = [
      {
        envGatewayKey: "cf-gateway-test-key",
        textValues: ["cf-account-id", "cf-gateway-id"],
        confirmValue: true,
        expectEnvPrompt: true,
        expectedTextCalls: 2,
        expectedKey: "cf-gateway-test-key",
        expectedMetadata: {
          accountId: "cf-account-id",
          gatewayId: "cf-gateway-id",
        },
      },
      {
        envGatewayKey: "cf-gateway-ref-key",
        textValues: ["cf-account-id-ref", "cf-gateway-id-ref"],
        confirmValue: true,
        opts: {
          secretInputMode: "ref", // pragma: allowlist secret
        },
        expectEnvPrompt: false,
        expectedTextCalls: 3,
        expectedKeyRef: { source: "env", provider: "default", id: "CLOUDFLARE_AI_GATEWAY_API_KEY" },
        expectedMetadata: {
          accountId: "cf-account-id-ref",
          gatewayId: "cf-gateway-id-ref",
        },
      },
      {
        textValues: [],
        confirmValue: false,
        opts: {
          cloudflareAiGatewayAccountId: "acc-direct",
          cloudflareAiGatewayGatewayId: "gw-direct",
          cloudflareAiGatewayApiKey: "cf-direct-key", // pragma: allowlist secret
        },
        expectEnvPrompt: false,
        expectedTextCalls: 0,
        expectedKey: "cf-direct-key",
        expectedMetadata: {
          accountId: "acc-direct",
          gatewayId: "gw-direct",
        },
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();
      delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
      if (scenario.envGatewayKey) {
        process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = scenario.envGatewayKey;
      }

      const text = vi.fn();
      for (const textValue of scenario.textValues) {
        text.mockResolvedValueOnce(textValue);
      }
      const confirm = vi.fn(async () => scenario.confirmValue);
      const { prompter, runtime } = createApiKeyPromptHarness({ text, confirm });

      const result = await applyAuthChoice({
        authChoice: "cloudflare-ai-gateway-api-key",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: scenario.opts,
      });

      if (scenario.expectEnvPrompt) {
        expect(confirm).toHaveBeenCalledWith(
          expect.objectContaining({
            message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_API_KEY"),
          }),
        );
      } else {
        expect(confirm).not.toHaveBeenCalled();
      }
      expect(text).toHaveBeenCalledTimes(scenario.expectedTextCalls);
      expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
        provider: "cloudflare-ai-gateway",
        mode: "api_key",
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        "cloudflare-ai-gateway/claude-sonnet-4-5",
      );

      const profile = await readAuthProfile("cloudflare-ai-gateway:default");
      if (scenario.expectedKeyRef) {
        expect(profile?.keyRef).toEqual(scenario.expectedKeyRef);
      } else {
        expect(profile?.key).toBe(scenario.expectedKey);
      }
      expect(profile?.metadata).toEqual(scenario.expectedMetadata);
    }
    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
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
      if (params.message.startsWith("Paste the redirect URL")) {
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
        message: expect.stringContaining("Paste the redirect URL"),
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

  it("writes portal OAuth credentials for plugin providers", async () => {
    const scenarios: Array<{
      authChoice: "qwen-portal" | "minimax-global-oauth";
      label: string;
      authId: string;
      authLabel: string;
      providerId: string;
      profileId: string;
      baseUrl: string;
      api: "openai-completions" | "anthropic-messages";
      defaultModel: string;
      apiKey: string;
      selectValue?: string;
    }> = [
      {
        authChoice: "qwen-portal",
        label: "Qwen",
        authId: "device",
        authLabel: "Qwen OAuth",
        providerId: "qwen-portal",
        profileId: "qwen-portal:default",
        baseUrl: "https://portal.qwen.ai/v1",
        api: "openai-completions",
        defaultModel: "qwen-portal/coder-model",
        apiKey: "qwen-oauth", // pragma: allowlist secret
      },
      {
        authChoice: "minimax-global-oauth",
        label: "MiniMax",
        authId: "oauth",
        authLabel: "MiniMax OAuth (Global)",
        providerId: "minimax-portal",
        profileId: "minimax-portal:default",
        baseUrl: "https://api.minimax.io/anthropic",
        api: "anthropic-messages",
        defaultModel: "minimax-portal/MiniMax-M2.7",
        apiKey: "minimax-oauth", // pragma: allowlist secret
      },
    ];
    for (const scenario of scenarios) {
      await setupTempState();

      resolvePluginProviders.mockReturnValue([
        {
          id: scenario.providerId,
          label: scenario.label,
          auth: [
            {
              id: scenario.authId,
              label: scenario.authLabel,
              kind: "device_code",
              wizard: { choiceId: scenario.authChoice },
              run: vi.fn(async () => ({
                profiles: [
                  {
                    profileId: scenario.profileId,
                    credential: {
                      type: "oauth",
                      provider: scenario.providerId,
                      access: "access",
                      refresh: "refresh",
                      expires: Date.now() + 60 * 60 * 1000,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [scenario.providerId]: {
                        baseUrl: scenario.baseUrl,
                        apiKey: scenario.apiKey,
                        api: scenario.api,
                        models: [],
                      },
                    },
                  },
                },
                defaultModel: scenario.defaultModel,
              })),
            },
          ],
        },
      ] as never);

      const prompter = createPrompter(
        scenario.selectValue
          ? { select: vi.fn(async () => scenario.selectValue as never) as WizardPrompter["select"] }
          : {},
      );
      const runtime = createExitThrowingRuntime();

      const result = await applyAuthChoice({
        authChoice: scenario.authChoice,
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.auth?.profiles?.[scenario.profileId]).toMatchObject({
        provider: scenario.providerId,
        mode: "oauth",
      });
      expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
        scenario.defaultModel,
      );
      expect(result.config.models?.providers?.[scenario.providerId]).toMatchObject({
        baseUrl: scenario.baseUrl,
        apiKey: scenario.apiKey,
      });
      expect(await readAuthProfile(scenario.profileId)).toMatchObject({
        provider: scenario.providerId,
        access: "access",
        refresh: "refresh",
      });
    }
  });
});

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps known and unknown auth choices", async () => {
    const scenarios = [
      { authChoice: "github-copilot" as const, expectedProvider: "github-copilot" },
      { authChoice: "qwen-portal" as const, expectedProvider: "qwen-portal" },
      { authChoice: "mistral-api-key" as const, expectedProvider: "mistral" },
      { authChoice: "ollama" as const, expectedProvider: "ollama" },
      { authChoice: "unknown" as AuthChoice, expectedProvider: undefined },
    ] as const;
    for (const scenario of scenarios) {
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice }),
      ).resolves.toBe(scenario.expectedProvider);
    }
  });
});
