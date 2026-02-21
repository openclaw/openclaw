import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyAuthProfileConfig,
  applyLitellmProviderConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyXaiConfig,
  applyXaiProviderConfig,
  applyXiaomiConfig,
  applyXiaomiProviderConfig,
  applyZaiConfig,
  applyZaiProviderConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MODEL_REF,
  setMinimaxApiKey,
  writeOAuthCredentials,
  ZAI_CODING_CN_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./onboard-auth.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function createLegacyProviderConfig(params: {
  providerId: string;
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  modelId?: string;
  modelName?: string;
  baseUrl?: string;
  apiKey?: string;
}): OpenClawConfig {
  return {
    models: {
      providers: {
        [params.providerId]: {
          baseUrl: params.baseUrl ?? "https://old.example.com",
          apiKey: params.apiKey ?? "old-key",
          api: params.api,
          models: [
            {
              id: params.modelId ?? "old-model",
              name: params.modelName ?? "Old",
              reasoning: false,
              input: ["text"],
              cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1000,
              maxTokens: 100,
            },
          ],
        },
      },
    },
  } as OpenClawConfig;
}

const EXPECTED_FALLBACKS = ["anthropic/claude-opus-4-5"] as const;

function createConfigWithFallbacks() {
  return {
    agents: {
      defaults: {
        model: { fallbacks: [...EXPECTED_FALLBACKS] },
      },
    },
  };
}

function expectFallbacksPreserved(cfg: ReturnType<typeof applyMinimaxApiConfig>) {
  expect(cfg.agents?.defaults?.model?.fallbacks).toEqual([...EXPECTED_FALLBACKS]);
}

function expectPrimaryModelPreserved(cfg: ReturnType<typeof applyMinimaxApiProviderConfig>) {
  expect(cfg.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
}

function expectAllowlistContains(
  cfg: ReturnType<typeof applyOpenrouterProviderConfig>,
  key: string,
) {
  const models = cfg.agents?.defaults?.models ?? {};
  expect(Object.keys(models)).toContain(key);
}

function expectAliasPreserved(
  cfg: ReturnType<typeof applyOpenrouterProviderConfig>,
  key: string,
  alias: string,
) {
  expect(cfg.agents?.defaults?.models?.[key]?.alias).toBe(alias);
}

describe("writeOAuthCredentials", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OPENCLAW_OAUTH_DIR",
  ]);

  let tempStateDir: string;
  const authProfilePathFor = (dir: string) => path.join(dir, "auth-profiles.json");

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes auth-profiles.json under OPENCLAW_AGENT_DIR when set", async () => {
    const env = await setupAuthTestEnv("openclaw-oauth-");
    lifecycle.setStateDir(env.stateDir);

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds);

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
      refresh: "refresh-token",
      access: "access-token",
      type: "oauth",
    });

    await expect(
      fs.readFile(path.join(env.stateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("writes OAuth credentials to all sibling agent dirs when syncSiblingAgents=true", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-sync-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    const workerAgentDir = path.join(tempStateDir, "agents", "worker", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });
    await fs.mkdir(workerAgentDir, { recursive: true });

    process.env.OPENCLAW_AGENT_DIR = kidAgentDir;
    process.env.PI_CODING_AGENT_DIR = kidAgentDir;

    const creds = {
      refresh: "refresh-sync",
      access: "access-sync",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds, undefined, {
      syncSiblingAgents: true,
    });

    for (const dir of [mainAgentDir, kidAgentDir, workerAgentDir]) {
      const raw = await fs.readFile(authProfilePathFor(dir), "utf8");
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      };
      expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
        refresh: "refresh-sync",
        access: "access-sync",
        type: "oauth",
      });
    }
  });

  it("writes OAuth credentials only to target dir by default", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-nosync-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    const mainAgentDir = path.join(tempStateDir, "agents", "main", "agent");
    const kidAgentDir = path.join(tempStateDir, "agents", "kid", "agent");
    await fs.mkdir(mainAgentDir, { recursive: true });
    await fs.mkdir(kidAgentDir, { recursive: true });

    process.env.OPENCLAW_AGENT_DIR = kidAgentDir;
    process.env.PI_CODING_AGENT_DIR = kidAgentDir;

    const creds = {
      refresh: "refresh-kid",
      access: "access-kid",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds, kidAgentDir);

    const kidRaw = await fs.readFile(authProfilePathFor(kidAgentDir), "utf8");
    const kidParsed = JSON.parse(kidRaw) as {
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    };
    expect(kidParsed.profiles?.["openai-codex:default"]).toMatchObject({
      access: "access-kid",
      type: "oauth",
    });

    await expect(fs.readFile(authProfilePathFor(mainAgentDir), "utf8")).rejects.toThrow();
  });

  it("syncs siblings from explicit agentDir outside OPENCLAW_STATE_DIR", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-external-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;

    // Create standard-layout agents tree *outside* OPENCLAW_STATE_DIR
    const externalRoot = path.join(tempStateDir, "external", "agents");
    const extMain = path.join(externalRoot, "main", "agent");
    const extKid = path.join(externalRoot, "kid", "agent");
    const extWorker = path.join(externalRoot, "worker", "agent");
    await fs.mkdir(extMain, { recursive: true });
    await fs.mkdir(extKid, { recursive: true });
    await fs.mkdir(extWorker, { recursive: true });

    const creds = {
      refresh: "refresh-ext",
      access: "access-ext",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds, extKid, {
      syncSiblingAgents: true,
    });

    // All siblings under the external root should have credentials
    for (const dir of [extMain, extKid, extWorker]) {
      const raw = await fs.readFile(authProfilePathFor(dir), "utf8");
      const parsed = JSON.parse(raw) as {
        profiles?: Record<string, OAuthCredentials & { type?: string }>;
      };
      expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
        refresh: "refresh-ext",
        access: "access-ext",
        type: "oauth",
      });
    }

    // Global state dir should NOT have credentials written
    const globalMain = path.join(tempStateDir, "agents", "main", "agent");
    await expect(fs.readFile(authProfilePathFor(globalMain), "utf8")).rejects.toThrow();
  });
});

describe("setMinimaxApiKey", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes to OPENCLAW_AGENT_DIR when set", async () => {
    const env = await setupAuthTestEnv("openclaw-minimax-", { agentSubdir: "custom-agent" });
    lifecycle.setStateDir(env.stateDir);

    await setMinimaxApiKey("sk-minimax-test");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["minimax:default"]).toMatchObject({
      type: "api_key",
      provider: "minimax",
      key: "sk-minimax-test",
    });

    await expect(
      fs.readFile(path.join(env.stateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("applyAuthProfileConfig", () => {
  it("promotes the newly selected profile to the front of auth.order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
          },
          order: { anthropic: ["anthropic:default"] },
        },
      },
      {
        profileId: "anthropic:work",
        provider: "anthropic",
        mode: "oauth",
      },
    );

    expect(next.auth?.order?.anthropic).toEqual(["anthropic:work", "anthropic:default"]);
  });
});

describe("applyMinimaxApiConfig", () => {
  it("adds minimax provider with correct settings", () => {
    const cfg = applyMinimaxApiConfig({});
    expect(cfg.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
    });
  });

  it("does not set reasoning for non-reasoning models", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(false);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyMinimaxApiConfig(createConfigWithFallbacks());
    expectFallbacksPreserved(cfg);
  });

  it("adds model alias", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1");
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.1"]?.alias).toBe("Minimax");
  });

  it("preserves existing model params when adding alias", () => {
    const cfg = applyMinimaxApiConfig(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.1": {
                alias: "MiniMax",
                params: { custom: "value" },
              },
            },
          },
        },
      },
      "MiniMax-M2.1",
    );
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.1"]).toMatchObject({
      alias: "Minimax",
      params: { custom: "value" },
    });
  });

  it("merges existing minimax provider models", () => {
    const cfg = applyMinimaxApiConfig(
      createLegacyProviderConfig({
        providerId: "minimax",
        api: "openai-completions",
      }),
    );
    expect(cfg.models?.providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(cfg.models?.providers?.minimax?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.minimax?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
      "old-model",
      "MiniMax-M2.5",
    ]);
  });

  it("preserves other providers when adding minimax", () => {
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic-key",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                reasoning: false,
                input: ["text"],
                cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });
    expect(cfg.models?.providers?.anthropic).toBeDefined();
    expect(cfg.models?.providers?.minimax).toBeDefined();
  });

  it("preserves existing models mode", () => {
    const cfg = applyMinimaxApiConfig({
      models: { mode: "replace", providers: {} },
    });
    expect(cfg.models?.mode).toBe("replace");
  });
});

describe("provider config helpers", () => {
  it("does not overwrite existing primary model", () => {
    const providerConfigAppliers = [applyMinimaxApiProviderConfig, applyZaiProviderConfig];
    for (const applyConfig of providerConfigAppliers) {
      const cfg = applyConfig({
        agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
      });
      expectPrimaryModelPreserved(cfg);
    }
  });
});

describe("applyZaiConfig", () => {
  it("adds zai provider with correct settings", () => {
    const cfg = applyZaiConfig({});
    expect(cfg.models?.providers?.zai).toMatchObject({
      // Default: general (non-coding) endpoint. Coding Plan endpoint is detected during onboarding.
      baseUrl: ZAI_GLOBAL_BASE_URL,
      api: "openai-completions",
    });
    const ids = cfg.models?.providers?.zai?.models?.map((m) => m.id);
    expect(ids).toContain("glm-5");
    expect(ids).toContain("glm-4.7");
    expect(ids).toContain("glm-4.7-flash");
    expect(ids).toContain("glm-4.7-flashx");
  });

  it("supports CN endpoint for supported coding models", () => {
    for (const modelId of ["glm-4.7-flash", "glm-4.7-flashx"] as const) {
      const cfg = applyZaiConfig({}, { endpoint: "coding-cn", modelId });
      expect(cfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
      expect(cfg.agents?.defaults?.model?.primary).toBe(`zai/${modelId}`);
    }
  });
});

describe("applySyntheticConfig", () => {
  it("adds synthetic provider with correct settings", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.models?.providers?.synthetic).toMatchObject({
      baseUrl: "https://api.synthetic.new/anthropic",
      api: "anthropic-messages",
    });
  });

  it("merges existing synthetic provider models", () => {
    const cfg = applySyntheticProviderConfig(
      createLegacyProviderConfig({
        providerId: "synthetic",
        api: "openai-completions",
      }),
    );
    expect(cfg.models?.providers?.synthetic?.baseUrl).toBe("https://api.synthetic.new/anthropic");
    expect(cfg.models?.providers?.synthetic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.synthetic?.apiKey).toBe("old-key");
    const ids = cfg.models?.providers?.synthetic?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_ID);
  });
});

describe("primary model defaults", () => {
  it("sets correct primary model", () => {
    const configCases = [
      {
        getConfig: () => applyMinimaxApiConfig({}, "MiniMax-M2.1-lightning"),
        primaryModel: "minimax/MiniMax-M2.1-lightning",
      },
      {
        getConfig: () => applyZaiConfig({}, { modelId: "glm-5" }),
        primaryModel: "zai/glm-5",
      },
      {
        getConfig: () => applySyntheticConfig({}),
        primaryModel: SYNTHETIC_DEFAULT_MODEL_REF,
      },
    ] as const;
    for (const { getConfig, primaryModel } of configCases) {
      const cfg = getConfig();
      expect(cfg.agents?.defaults?.model?.primary).toBe(primaryModel);
    }
  });
});

describe("applyXiaomiConfig", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    expect(cfg.models?.providers?.xiaomi).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/anthropic",
      api: "anthropic-messages",
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe("xiaomi/mimo-v2-flash");
  });

  it("merges Xiaomi models and keeps existing provider overrides", () => {
    const cfg = applyXiaomiProviderConfig(
      createLegacyProviderConfig({
        providerId: "xiaomi",
        api: "openai-completions",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.xiaomi?.baseUrl).toBe("https://api.xiaomimimo.com/anthropic");
    expect(cfg.models?.providers?.xiaomi?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.xiaomi?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mimo-v2-flash",
    ]);
  });
});

describe("applyXaiConfig", () => {
  it("adds xAI provider with correct settings", () => {
    const cfg = applyXaiConfig({});
    expect(cfg.models?.providers?.xai).toMatchObject({
      baseUrl: "https://api.x.ai/v1",
      api: "openai-completions",
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe(XAI_DEFAULT_MODEL_REF);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyXaiConfig(createConfigWithFallbacks());
    expectFallbacksPreserved(cfg);
  });
});

describe("applyXaiProviderConfig", () => {
  it("adds model alias", () => {
    const cfg = applyXaiProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("merges xAI models and keeps existing provider overrides", () => {
    const cfg = applyXaiProviderConfig(
      createLegacyProviderConfig({
        providerId: "xai",
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual(["custom-model", "grok-4"]);
  });
});

describe("allowlist provider helpers", () => {
  it("adds allowlist entry and preserves alias", () => {
    const providerCases = [
      {
        applyConfig: applyOpencodeZenProviderConfig,
        modelRef: "opencode/claude-opus-4-6",
        alias: "My Opus",
      },
      {
        applyConfig: applyOpenrouterProviderConfig,
        modelRef: OPENROUTER_DEFAULT_MODEL_REF,
        alias: "Router",
      },
    ] as const;
    for (const { applyConfig, modelRef, alias } of providerCases) {
      const withDefault = applyConfig({});
      expectAllowlistContains(withDefault, modelRef);

      const withAlias = applyConfig({
        agents: {
          defaults: {
            models: {
              [modelRef]: { alias },
            },
          },
        },
      });
      expectAliasPreserved(withAlias, modelRef, alias);
    }
  });
});

describe("applyLitellmProviderConfig", () => {
  it("preserves existing baseUrl and api key while adding the default model", () => {
    const cfg = applyLitellmProviderConfig(
      createLegacyProviderConfig({
        providerId: "litellm",
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
        baseUrl: "https://litellm.example/v1",
        apiKey: "  old-key  ",
      }),
    );

    expect(cfg.models?.providers?.litellm?.baseUrl).toBe("https://litellm.example/v1");
    expect(cfg.models?.providers?.litellm?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.litellm?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.litellm?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "claude-opus-4-6",
    ]);
  });
});

describe("default-model config helpers", () => {
  it("sets primary model and preserves existing model fallbacks", () => {
    const configCases = [
      {
        applyConfig: applyOpencodeZenConfig,
        primaryModel: "opencode/claude-opus-4-6",
      },
      {
        applyConfig: applyOpenrouterConfig,
        primaryModel: OPENROUTER_DEFAULT_MODEL_REF,
      },
    ] as const;
    for (const { applyConfig, primaryModel } of configCases) {
      const cfg = applyConfig({});
      expect(cfg.agents?.defaults?.model?.primary).toBe(primaryModel);

      const cfgWithFallbacks = applyConfig(createConfigWithFallbacks());
      expectFallbacksPreserved(cfgWithFallbacks);
    }
  });
});
