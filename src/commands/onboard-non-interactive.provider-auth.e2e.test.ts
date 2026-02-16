import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { MINIMAX_API_BASE_URL, MINIMAX_CN_API_BASE_URL } from "./onboard-auth.js";
import { OPENAI_DEFAULT_MODEL } from "./openai-model-default.js";

type RuntimeMock = {
  log: () => void;
  error: (msg: string) => never;
  exit: (code: number) => never;
};

type OnboardEnv = {
  configPath: string;
  runtime: RuntimeMock;
};

type ProviderAuthConfigSnapshot = {
  auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
  agents?: { defaults?: { model?: { primary?: string } } };
  models?: { providers?: Record<string, { baseUrl?: string }> };
};

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isTransient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!isTransient || attempt === 4) {
        throw error;
      }
      await delay(25 * (attempt + 1));
    }
  }
}

async function withOnboardEnv(
  prefix: string,
  run: (ctx: OnboardEnv) => Promise<void>,
): Promise<void> {
  const prev = captureEnv([
    "HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "OPENCLAW_SKIP_CHANNELS",
    "OPENCLAW_SKIP_GMAIL_WATCHER",
    "OPENCLAW_SKIP_CRON",
    "OPENCLAW_SKIP_CANVAS_HOST",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_GATEWAY_PASSWORD",
    "CUSTOM_API_KEY",
    "OPENCLAW_DISABLE_CONFIG_CACHE",
  ]);

  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_DISABLE_CONFIG_CACHE = "1";
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  delete process.env.CUSTOM_API_KEY;

  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tempHome, "openclaw.json");
  process.env.HOME = tempHome;
  process.env.OPENCLAW_STATE_DIR = tempHome;
  process.env.OPENCLAW_CONFIG_PATH = configPath;

  const runtime: RuntimeMock = {
    log: () => {},
    error: (msg: string) => {
      throw new Error(msg);
    },
    exit: (code: number) => {
      throw new Error(`exit:${code}`);
    },
  };

  try {
    await run({ configPath, runtime });
  } finally {
    await removeDirWithRetry(tempHome);
    prev.restore();
  }
}

async function runNonInteractive(
  options: Record<string, unknown>,
  runtime: RuntimeMock,
): Promise<void> {
  const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
  await runNonInteractiveOnboarding(options, runtime);
}

async function runNonInteractiveWithDefaults(
  runtime: RuntimeMock,
  options: Record<string, unknown>,
): Promise<void> {
  await runNonInteractive(
    {
      nonInteractive: true,
      skipHealth: true,
      skipChannels: true,
      json: true,
      ...options,
    },
    runtime,
  );
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function runApiKeyOnboardingAndReadConfig(
  env: OnboardEnv,
  options: Record<string, unknown>,
): Promise<ProviderAuthConfigSnapshot> {
  await runNonInteractiveWithDefaults(env.runtime, {
    skipSkills: true,
    ...options,
  });
  return readJsonFile<ProviderAuthConfigSnapshot>(env.configPath);
}

async function runInferredApiKeyOnboardingAndReadConfig(
  env: OnboardEnv,
  options: Record<string, unknown>,
): Promise<ProviderAuthConfigSnapshot> {
  await runNonInteractive(
    {
      nonInteractive: true,
      skipHealth: true,
      skipChannels: true,
      skipSkills: true,
      json: true,
      ...options,
    },
    env.runtime,
  );
  return readJsonFile<ProviderAuthConfigSnapshot>(env.configPath);
}

const CUSTOM_LOCAL_BASE_URL = "https://models.custom.local/v1";
const CUSTOM_LOCAL_MODEL_ID = "local-large";
const CUSTOM_LOCAL_PROVIDER_ID = "custom-models-custom-local";

async function runCustomLocalNonInteractive(
  runtime: RuntimeMock,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await runNonInteractiveWithDefaults(runtime, {
    authChoice: "custom-api-key",
    customBaseUrl: CUSTOM_LOCAL_BASE_URL,
    customModelId: CUSTOM_LOCAL_MODEL_ID,
    skipSkills: true,
    ...overrides,
  });
}

async function readCustomLocalProviderApiKey(configPath: string): Promise<string | undefined> {
  const cfg = await readJsonFile<{
    models?: {
      providers?: Record<
        string,
        {
          apiKey?: string;
        }
      >;
    };
  }>(configPath);
  return cfg.models?.providers?.[CUSTOM_LOCAL_PROVIDER_ID]?.apiKey;
}

async function expectApiKeyProfile(params: {
  profileId: string;
  provider: string;
  key: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
  const store = ensureAuthProfileStore();
  const profile = store.profiles[params.profileId];
  expect(profile?.type).toBe("api_key");
  if (profile?.type === "api_key") {
    expect(profile.provider).toBe(params.provider);
    expect(profile.key).toBe(params.key);
    if (params.metadata) {
      expect(profile.metadata).toEqual(params.metadata);
    }
  }
}

describe("onboard (non-interactive): provider auth", () => {
  it("stores MiniMax API key and uses global baseUrl by default", async () => {
    await withOnboardEnv("openclaw-onboard-minimax-", async (env) => {
      const cfg = await runApiKeyOnboardingAndReadConfig(env, {
        authChoice: "minimax-api",
        minimaxApiKey: "sk-minimax-test",
      });

      expect(cfg.auth?.profiles?.["minimax:default"]?.provider).toBe("minimax");
      expect(cfg.auth?.profiles?.["minimax:default"]?.mode).toBe("api_key");
      expect(cfg.models?.providers?.minimax?.baseUrl).toBe(MINIMAX_API_BASE_URL);
      expect(cfg.agents?.defaults?.model?.primary).toBe("minimax/MiniMax-M2.5");
      await expectApiKeyProfile({
        profileId: "minimax:default",
        provider: "minimax",
        key: "sk-minimax-test",
      });
    });
  }, 60_000);

  it("supports MiniMax CN API endpoint auth choice", async () => {
    await withOnboardEnv("openclaw-onboard-minimax-cn-", async (env) => {
      const cfg = await runApiKeyOnboardingAndReadConfig(env, {
        authChoice: "minimax-api-key-cn",
        minimaxApiKey: "sk-minimax-test",
      });

      expect(cfg.auth?.profiles?.["minimax-cn:default"]?.provider).toBe("minimax-cn");
      expect(cfg.auth?.profiles?.["minimax-cn:default"]?.mode).toBe("api_key");
      expect(cfg.models?.providers?.["minimax-cn"]?.baseUrl).toBe(MINIMAX_CN_API_BASE_URL);
      expect(cfg.agents?.defaults?.model?.primary).toBe("minimax-cn/MiniMax-M2.5");
      await expectApiKeyProfile({
        profileId: "minimax-cn:default",
        provider: "minimax-cn",
        key: "sk-minimax-test",
      });
    });
  }, 60_000);

  it("stores Z.AI API key and uses global baseUrl by default", async () => {
    await withOnboardEnv("openclaw-onboard-zai-", async ({ configPath, runtime }) => {
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "zai-api-key",
        zaiApiKey: "zai-test-key",
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
        agents?: { defaults?: { model?: { primary?: string } } };
        models?: { providers?: Record<string, { baseUrl?: string }> };
      }>(configPath);

      expect(cfg.auth?.profiles?.["zai:default"]?.provider).toBe("zai");
      expect(cfg.auth?.profiles?.["zai:default"]?.mode).toBe("api_key");
      expect(cfg.models?.providers?.zai?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
      expect(cfg.agents?.defaults?.model?.primary).toBe("zai/glm-5");
      await expectApiKeyProfile({ profileId: "zai:default", provider: "zai", key: "zai-test-key" });
    });
  }, 60_000);

  it("supports Z.AI CN coding endpoint auth choice", async () => {
    await withOnboardEnv("openclaw-onboard-zai-cn-", async ({ configPath, runtime }) => {
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "zai-coding-cn",
        zaiApiKey: "zai-test-key",
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        models?: { providers?: Record<string, { baseUrl?: string }> };
      }>(configPath);

      expect(cfg.models?.providers?.zai?.baseUrl).toBe(
        "https://open.bigmodel.cn/api/coding/paas/v4",
      );
    });
  }, 60_000);

  it("stores xAI API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-xai-", async ({ configPath, runtime }) => {
      const rawKey = "xai-test-\r\nkey";
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "xai-api-key",
        xaiApiKey: rawKey,
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      expect(cfg.auth?.profiles?.["xai:default"]?.provider).toBe("xai");
      expect(cfg.auth?.profiles?.["xai:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("xai/grok-4");
      await expectApiKeyProfile({ profileId: "xai:default", provider: "xai", key: "xai-test-key" });
    });
  }, 60_000);

  it("stores Vercel AI Gateway API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-ai-gateway-", async ({ configPath, runtime }) => {
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "ai-gateway-api-key",
        aiGatewayApiKey: "gateway-test-key",
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      expect(cfg.auth?.profiles?.["vercel-ai-gateway:default"]?.provider).toBe("vercel-ai-gateway");
      expect(cfg.auth?.profiles?.["vercel-ai-gateway:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe(
        "vercel-ai-gateway/anthropic/claude-opus-4.6",
      );
      await expectApiKeyProfile({
        profileId: "vercel-ai-gateway:default",
        provider: "vercel-ai-gateway",
        key: "gateway-test-key",
      });
    });
  }, 60_000);

  it("stores token auth profile", async () => {
    await withOnboardEnv("openclaw-onboard-token-", async ({ configPath, runtime }) => {
      const cleanToken = `sk-ant-oat01-${"a".repeat(80)}`;
      const token = `${cleanToken.slice(0, 30)}\r${cleanToken.slice(30)}`;

      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "token",
        tokenProvider: "anthropic",
        token,
        tokenProfileId: "anthropic:default",
      });

      const cfg = await readJsonFile<{
        auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
      }>(configPath);

      expect(cfg.auth?.profiles?.["anthropic:default"]?.provider).toBe("anthropic");
      expect(cfg.auth?.profiles?.["anthropic:default"]?.mode).toBe("token");

      const { ensureAuthProfileStore } = await import("../agents/auth-profiles.js");
      const store = ensureAuthProfileStore();
      const profile = store.profiles["anthropic:default"];
      expect(profile?.type).toBe("token");
      if (profile?.type === "token") {
        expect(profile.provider).toBe("anthropic");
        expect(profile.token).toBe(cleanToken);
      }
    });
  }, 60_000);

  it("stores OpenAI API key and sets OpenAI default model", async () => {
    await withOnboardEnv("openclaw-onboard-openai-", async ({ configPath, runtime }) => {
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "openai-api-key",
        openaiApiKey: "sk-openai-test",
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      expect(cfg.agents?.defaults?.model?.primary).toBe(OPENAI_DEFAULT_MODEL);
    });
  }, 60_000);

  it("rejects vLLM auth choice in non-interactive mode", async () => {
    await withOnboardEnv("openclaw-onboard-vllm-non-interactive-", async ({ runtime }) => {
      await expect(
        runNonInteractiveWithDefaults(runtime, {
          authChoice: "vllm",
          skipSkills: true,
        }),
      ).rejects.toThrow('Auth choice "vllm" requires interactive mode.');
    });
  }, 60_000);

  it("stores LiteLLM API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-litellm-", async ({ configPath, runtime }) => {
      await runNonInteractiveWithDefaults(runtime, {
        authChoice: "litellm-api-key",
        litellmApiKey: "litellm-test-key",
        skipSkills: true,
      });

      const cfg = await readJsonFile<{
        auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      expect(cfg.auth?.profiles?.["litellm:default"]?.provider).toBe("litellm");
      expect(cfg.auth?.profiles?.["litellm:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("litellm/claude-opus-4-6");
      await expectApiKeyProfile({
        profileId: "litellm:default",
        provider: "litellm",
        key: "litellm-test-key",
      });
    });
  }, 60_000);

  it.each([
    {
      name: "stores Cloudflare AI Gateway API key and metadata",
      prefix: "openclaw-onboard-cf-gateway-",
      options: {
        authChoice: "cloudflare-ai-gateway-api-key",
      },
    },
    {
      name: "infers Cloudflare auth choice from API key flags",
      prefix: "openclaw-onboard-cf-gateway-infer-",
      options: {},
    },
  ])(
    "$name",
    async ({ prefix, options }) => {
      await withOnboardEnv(prefix, async ({ configPath, runtime }) => {
        await runNonInteractive(
          {
            nonInteractive: true,
            cloudflareAiGatewayAccountId: "cf-account-id",
            cloudflareAiGatewayGatewayId: "cf-gateway-id",
            cloudflareAiGatewayApiKey: "cf-gateway-test-key",
            skipHealth: true,
            skipChannels: true,
            skipSkills: true,
            json: true,
            ...options,
          },
          runtime,
        );

        const cfg = await readJsonFile<{
          auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
          agents?: { defaults?: { model?: { primary?: string } } };
        }>(configPath);

        expect(cfg.auth?.profiles?.["cloudflare-ai-gateway:default"]?.provider).toBe(
          "cloudflare-ai-gateway",
        );
        expect(cfg.auth?.profiles?.["cloudflare-ai-gateway:default"]?.mode).toBe("api_key");
        expect(cfg.agents?.defaults?.model?.primary).toBe(
          "cloudflare-ai-gateway/claude-sonnet-4-5",
        );
        await expectApiKeyProfile({
          profileId: "cloudflare-ai-gateway:default",
          provider: "cloudflare-ai-gateway",
          key: "cf-gateway-test-key",
          metadata: { accountId: "cf-account-id", gatewayId: "cf-gateway-id" },
        });
      });
    },
    60_000,
  );

  it("infers Together auth choice from --together-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-together-infer-", async (env) => {
      const cfg = await runInferredApiKeyOnboardingAndReadConfig(env, {
        togetherApiKey: "together-test-key",
      });

      expect(cfg.auth?.profiles?.["together:default"]?.provider).toBe("together");
      expect(cfg.auth?.profiles?.["together:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("together/moonshotai/Kimi-K2.5");
      await expectApiKeyProfile({
        profileId: "together:default",
        provider: "together",
        key: "together-test-key",
      });
    });
  }, 60_000);

  it("infers QIANFAN auth choice from --qianfan-api-key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-qianfan-infer-", async (env) => {
      const cfg = await runInferredApiKeyOnboardingAndReadConfig(env, {
        qianfanApiKey: "qianfan-test-key",
      });

      expect(cfg.auth?.profiles?.["qianfan:default"]?.provider).toBe("qianfan");
      expect(cfg.auth?.profiles?.["qianfan:default"]?.mode).toBe("api_key");
      expect(cfg.agents?.defaults?.model?.primary).toBe("qianfan/deepseek-v3.2");
      await expectApiKeyProfile({
        profileId: "qianfan:default",
        provider: "qianfan",
        key: "qianfan-test-key",
      });
    });
  }, 60_000);

  it("configures a custom provider from non-interactive flags", async () => {
    await withOnboardEnv("openclaw-onboard-custom-provider-", async ({ configPath, runtime }) => {
      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "custom-api-key",
          customBaseUrl: "https://llm.example.com/v1",
          customApiKey: "custom-test-key",
          customModelId: "foo-large",
          customCompatibility: "anthropic",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          json: true,
        },
        runtime,
      );

      const cfg = await readJsonFile<{
        models?: {
          providers?: Record<
            string,
            {
              baseUrl?: string;
              api?: string;
              apiKey?: string;
              models?: Array<{ id?: string }>;
            }
          >;
        };
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      const provider = cfg.models?.providers?.["custom-llm-example-com"];
      expect(provider?.baseUrl).toBe("https://llm.example.com/v1");
      expect(provider?.api).toBe("anthropic-messages");
      expect(provider?.apiKey).toBe("custom-test-key");
      expect(provider?.models?.some((model) => model.id === "foo-large")).toBe(true);
      expect(cfg.agents?.defaults?.model?.primary).toBe("custom-llm-example-com/foo-large");
    });
  }, 60_000);

  it("infers custom provider auth choice from custom flags", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-infer-",
      async ({ configPath, runtime }) => {
        await runNonInteractive(
          {
            nonInteractive: true,
            customBaseUrl: "https://models.custom.local/v1",
            customModelId: "local-large",
            customApiKey: "custom-test-key",
            skipHealth: true,
            skipChannels: true,
            skipSkills: true,
            json: true,
          },
          runtime,
        );

        const cfg = await readJsonFile<{
          models?: {
            providers?: Record<
              string,
              {
                baseUrl?: string;
                api?: string;
              }
            >;
          };
          agents?: { defaults?: { model?: { primary?: string } } };
        }>(configPath);

        expect(cfg.models?.providers?.["custom-models-custom-local"]?.baseUrl).toBe(
          "https://models.custom.local/v1",
        );
        expect(cfg.models?.providers?.["custom-models-custom-local"]?.api).toBe(
          "openai-completions",
        );
        expect(cfg.agents?.defaults?.model?.primary).toBe("custom-models-custom-local/local-large");
      },
    );
  }, 60_000);

  it("uses CUSTOM_API_KEY env fallback for non-interactive custom provider auth", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-env-fallback-",
      async ({ configPath, runtime }) => {
        process.env.CUSTOM_API_KEY = "custom-env-key";
        await runCustomLocalNonInteractive(runtime);
        expect(await readCustomLocalProviderApiKey(configPath)).toBe("custom-env-key");
      },
    );
  }, 60_000);

  it("uses matching profile fallback for non-interactive custom provider auth", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-profile-fallback-",
      async ({ configPath, runtime }) => {
        const { upsertAuthProfile } = await import("../agents/auth-profiles.js");
        upsertAuthProfile({
          profileId: `${CUSTOM_LOCAL_PROVIDER_ID}:default`,
          credential: {
            type: "api_key",
            provider: CUSTOM_LOCAL_PROVIDER_ID,
            key: "custom-profile-key",
          },
        });
        await runCustomLocalNonInteractive(runtime);
        expect(await readCustomLocalProviderApiKey(configPath)).toBe("custom-profile-key");
      },
    );
  }, 60_000);

  it("fails custom provider auth when compatibility is invalid", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-invalid-compat-",
      async ({ runtime }) => {
        await expect(
          runNonInteractive(
            {
              nonInteractive: true,
              authChoice: "custom-api-key",
              customBaseUrl: "https://models.custom.local/v1",
              customModelId: "local-large",
              customCompatibility: "xmlrpc",
              skipHealth: true,
              skipChannels: true,
              skipSkills: true,
              json: true,
            },
            runtime,
          ),
        ).rejects.toThrow('Invalid --custom-compatibility (use "openai" or "anthropic").');
      },
    );
  }, 60_000);

  it("fails custom provider auth when explicit provider id is invalid", async () => {
    await withOnboardEnv("openclaw-onboard-custom-provider-invalid-id-", async ({ runtime }) => {
      await expect(
        runNonInteractive(
          {
            nonInteractive: true,
            authChoice: "custom-api-key",
            customBaseUrl: "https://models.custom.local/v1",
            customModelId: "local-large",
            customProviderId: "!!!",
            skipHealth: true,
            skipChannels: true,
            skipSkills: true,
            json: true,
          },
          runtime,
        ),
      ).rejects.toThrow(
        "Invalid custom provider config: Custom provider ID must include letters, numbers, or hyphens.",
      );
    });
  }, 60_000);

  it("fails inferred custom auth when required flags are incomplete", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-missing-required-",
      async ({ runtime }) => {
        await expect(
          runNonInteractive(
            {
              nonInteractive: true,
              customApiKey: "custom-test-key",
              skipHealth: true,
              skipChannels: true,
              skipSkills: true,
              json: true,
            },
            runtime,
          ),
        ).rejects.toThrow('Auth choice "custom-api-key" requires a base URL and model ID.');
      },
    );
  }, 60_000);
});
