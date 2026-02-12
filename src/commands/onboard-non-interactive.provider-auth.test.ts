import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { OPENAI_DEFAULT_MODEL } from "./openai-model-default.js";

type RuntimeMock = {
  log: () => void;
  error: (msg: string) => never;
  exit: (code: number) => never;
};

type EnvSnapshot = {
  home: string | undefined;
  stateDir: string | undefined;
  configPath: string | undefined;
  skipChannels: string | undefined;
  skipGmail: string | undefined;
  skipCron: string | undefined;
  skipCanvas: string | undefined;
  token: string | undefined;
  password: string | undefined;
  customApiKey: string | undefined;
  disableConfigCache: string | undefined;
};

type OnboardEnv = {
  configPath: string;
  runtime: RuntimeMock;
};

function captureEnv(): EnvSnapshot {
  return {
    home: process.env.HOME,
    stateDir: process.env.OPENCLAW_STATE_DIR,
    configPath: process.env.OPENCLAW_CONFIG_PATH,
    skipChannels: process.env.OPENCLAW_SKIP_CHANNELS,
    skipGmail: process.env.OPENCLAW_SKIP_GMAIL_WATCHER,
    skipCron: process.env.OPENCLAW_SKIP_CRON,
    skipCanvas: process.env.OPENCLAW_SKIP_CANVAS_HOST,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    password: process.env.OPENCLAW_GATEWAY_PASSWORD,
    customApiKey: process.env.CUSTOM_API_KEY,
    disableConfigCache: process.env.OPENCLAW_DISABLE_CONFIG_CACHE,
  };
}

function restoreEnvVar(key: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value == null) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function restoreEnv(prev: EnvSnapshot): void {
  restoreEnvVar("HOME", prev.home);
  restoreEnvVar("OPENCLAW_STATE_DIR", prev.stateDir);
  restoreEnvVar("OPENCLAW_CONFIG_PATH", prev.configPath);
  restoreEnvVar("OPENCLAW_SKIP_CHANNELS", prev.skipChannels);
  restoreEnvVar("OPENCLAW_SKIP_GMAIL_WATCHER", prev.skipGmail);
  restoreEnvVar("OPENCLAW_SKIP_CRON", prev.skipCron);
  restoreEnvVar("OPENCLAW_SKIP_CANVAS_HOST", prev.skipCanvas);
  restoreEnvVar("OPENCLAW_GATEWAY_TOKEN", prev.token);
  restoreEnvVar("OPENCLAW_GATEWAY_PASSWORD", prev.password);
  restoreEnvVar("CUSTOM_API_KEY", prev.customApiKey);
  restoreEnvVar("OPENCLAW_DISABLE_CONFIG_CACHE", prev.disableConfigCache);
}

async function withOnboardEnv(
  prefix: string,
  run: (ctx: OnboardEnv) => Promise<void>,
): Promise<void> {
  const prev = captureEnv();

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
  vi.resetModules();

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
    await fs.rm(tempHome, { recursive: true, force: true });
    restoreEnv(prev);
  }
}

async function runNonInteractive(
  options: Record<string, unknown>,
  runtime: RuntimeMock,
): Promise<void> {
  const { runNonInteractiveOnboarding } = await import("./onboard-non-interactive.js");
  await runNonInteractiveOnboarding(options, runtime);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
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
  it("stores xAI API key and sets default model", async () => {
    await withOnboardEnv("openclaw-onboard-xai-", async ({ configPath, runtime }) => {
      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "xai-api-key",
          xaiApiKey: "xai-test-key",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          json: true,
        },
        runtime,
      );

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
      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "ai-gateway-api-key",
          aiGatewayApiKey: "gateway-test-key",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          json: true,
        },
        runtime,
      );

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
      const token = `sk-ant-oat01-${"a".repeat(80)}`;

      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "token",
          tokenProvider: "anthropic",
          token,
          tokenProfileId: "anthropic:default",
          skipHealth: true,
          skipChannels: true,
          json: true,
        },
        runtime,
      );

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
        expect(profile.token).toBe(token);
      }
    });
  }, 60_000);

  it("stores OpenAI API key and sets OpenAI default model", async () => {
    await withOnboardEnv("openclaw-onboard-openai-", async ({ configPath, runtime }) => {
      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "openai-api-key",
          openaiApiKey: "sk-openai-test",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          json: true,
        },
        runtime,
      );

      const cfg = await readJsonFile<{
        agents?: { defaults?: { model?: { primary?: string } } };
      }>(configPath);

      expect(cfg.agents?.defaults?.model?.primary).toBe(OPENAI_DEFAULT_MODEL);
    });
  }, 60_000);

  it("stores Cloudflare AI Gateway API key and metadata", async () => {
    await withOnboardEnv("openclaw-onboard-cf-gateway-", async ({ configPath, runtime }) => {
      await runNonInteractive(
        {
          nonInteractive: true,
          authChoice: "cloudflare-ai-gateway-api-key",
          cloudflareAiGatewayAccountId: "cf-account-id",
          cloudflareAiGatewayGatewayId: "cf-gateway-id",
          cloudflareAiGatewayApiKey: "cf-gateway-test-key",
          skipHealth: true,
          skipChannels: true,
          skipSkills: true,
          json: true,
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
      expect(cfg.agents?.defaults?.model?.primary).toBe("cloudflare-ai-gateway/claude-sonnet-4-5");
      await expectApiKeyProfile({
        profileId: "cloudflare-ai-gateway:default",
        provider: "cloudflare-ai-gateway",
        key: "cf-gateway-test-key",
        metadata: { accountId: "cf-account-id", gatewayId: "cf-gateway-id" },
      });
    });
  }, 60_000);

  it("infers Cloudflare auth choice from API key flags", async () => {
    await withOnboardEnv("openclaw-onboard-cf-gateway-infer-", async ({ configPath, runtime }) => {
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
      expect(cfg.agents?.defaults?.model?.primary).toBe("cloudflare-ai-gateway/claude-sonnet-4-5");
      await expectApiKeyProfile({
        profileId: "cloudflare-ai-gateway:default",
        provider: "cloudflare-ai-gateway",
        key: "cf-gateway-test-key",
        metadata: { accountId: "cf-account-id", gatewayId: "cf-gateway-id" },
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

        await runNonInteractive(
          {
            nonInteractive: true,
            authChoice: "custom-api-key",
            customBaseUrl: "https://models.custom.local/v1",
            customModelId: "local-large",
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
                apiKey?: string;
              }
            >;
          };
        }>(configPath);

        expect(cfg.models?.providers?.["custom-models-custom-local"]?.apiKey).toBe(
          "custom-env-key",
        );
      },
    );
  }, 60_000);

  it("uses matching profile fallback for non-interactive custom provider auth", async () => {
    await withOnboardEnv(
      "openclaw-onboard-custom-provider-profile-fallback-",
      async ({ configPath, runtime }) => {
        const { upsertAuthProfile } = await import("../agents/auth-profiles.js");
        upsertAuthProfile({
          profileId: "custom-models-custom-local:default",
          credential: {
            type: "api_key",
            provider: "custom-models-custom-local",
            key: "custom-profile-key",
          },
        });

        await runNonInteractive(
          {
            nonInteractive: true,
            authChoice: "custom-api-key",
            customBaseUrl: "https://models.custom.local/v1",
            customModelId: "local-large",
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
                apiKey?: string;
              }
            >;
          };
        }>(configPath);

        expect(cfg.models?.providers?.["custom-models-custom-local"]?.apiKey).toBe(
          "custom-profile-key",
        );
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
