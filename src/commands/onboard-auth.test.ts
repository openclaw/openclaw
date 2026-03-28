import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { applyLitellmProviderConfig } from "../../extensions/litellm/onboard.js";
import {
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
} from "../../extensions/minimax/onboard.js";
import { buildMistralModelDefinition as buildBundledMistralModelDefinition } from "../../extensions/mistral/model-definitions.js";
import {
  applyMistralConfig,
  applyMistralProviderConfig,
  MISTRAL_DEFAULT_MODEL_REF,
} from "../../extensions/mistral/onboard.js";
import {
  applyOpencodeGoConfig,
  applyOpencodeGoProviderConfig,
} from "../../extensions/opencode-go/onboard.js";
import {
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
} from "../../extensions/opencode/onboard.js";
import {
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
} from "../../extensions/openrouter/onboard.js";
import {
  applySyntheticConfig,
  applySyntheticProviderConfig,
  SYNTHETIC_DEFAULT_MODEL_REF,
} from "../../extensions/synthetic/onboard.js";
import {
  applyXaiConfig,
  applyXaiProviderConfig,
  XAI_DEFAULT_MODEL_REF,
} from "../../extensions/xai/onboard.js";
import { applyXiaomiConfig, applyXiaomiProviderConfig } from "../../extensions/xiaomi/onboard.js";
import {
  ZAI_CODING_CN_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "../../extensions/zai/model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig } from "../../extensions/zai/onboard.js";
import {
  createConfigWithFallbacks,
  createLegacyProviderConfig,
  EXPECTED_FALLBACKS,
} from "../../test/helpers/extensions/onboard-config.js";
import { SYNTHETIC_DEFAULT_MODEL_ID } from "../agents/synthetic-models.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { applyAuthProfileConfig } from "../plugins/provider-auth-helpers.js";
import { setMinimaxApiKey, writeOAuthCredentials } from "../plugins/provider-auth-storage.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function expectPrimaryModelPreserved(cfg: OpenClawConfig): void {
  expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
    "anthropic/claude-opus-4-5",
  );
}

function expectFallbacksPreserved(cfg: OpenClawConfig): void {
  expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
    ...EXPECTED_FALLBACKS,
  ]);
}

function expectAllowlistContains(cfg: OpenClawConfig, modelRef: string): void {
  expect(Object.keys(cfg.agents?.defaults?.models ?? {})).toContain(modelRef);
}

function expectAliasPreserved(cfg: OpenClawConfig, modelRef: string, alias: string): void {
  expect(cfg.agents?.defaults?.models?.[modelRef]?.alias).toBe(alias);
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

  it("creates provider order when switching from legacy oauth to api_key without explicit order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "kilocode:legacy": { provider: "kilocode", mode: "oauth" },
          },
        },
      },
      {
        profileId: "kilocode:default",
        provider: "kilocode",
        mode: "api_key",
      },
    );

    expect(next.auth?.order?.kilocode).toEqual(["kilocode:default", "kilocode:legacy"]);
  });

  it("repairs aliased auth.order keys instead of duplicating them", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "zai:default": { provider: "z.ai", mode: "api_key" },
          },
          order: { "z.ai": ["zai:default"] },
        },
      },
      {
        profileId: "zai:work",
        provider: "z-ai",
        mode: "oauth",
      },
    );

    expect(next.auth?.order).toEqual({
      zai: ["zai:work", "zai:default"],
    });
  });

  it("merges split canonical and aliased auth.order entries for the same provider", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "zai:default": { provider: "z.ai", mode: "api_key" },
            "zai:backup": { provider: "z-ai", mode: "token" },
          },
          order: {
            zai: ["zai:default"],
            "z.ai": ["zai:backup"],
          },
        },
      },
      {
        profileId: "zai:work",
        provider: "z-ai",
        mode: "oauth",
      },
    );

    expect(next.auth?.order).toEqual({
      zai: ["zai:work", "zai:default", "zai:backup"],
    });
  });

  it("keeps implicit round-robin when no mixed provider modes are present", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "kilocode:legacy": { provider: "kilocode", mode: "api_key" },
          },
        },
      },
      {
        profileId: "kilocode:default",
        provider: "kilocode",
        mode: "api_key",
      },
    );

    expect(next.auth?.order).toBeUndefined();
  });

  it("stores display metadata without overloading email", () => {
    const next = applyAuthProfileConfig(
      {},
      {
        profileId: "openai-codex:id-abc",
        provider: "openai-codex",
        mode: "oauth",
        displayName: "Work account",
      },
    );

    expect(next.auth?.profiles?.["openai-codex:id-abc"]).toEqual({
      provider: "openai-codex",
      mode: "oauth",
      displayName: "Work account",
    });
  });
});

describe("applyMinimaxApiConfig", () => {
  it("adds minimax provider with correct settings", () => {
    const cfg = applyMinimaxApiConfig({});
    expect(cfg.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
      authHeader: true,
    });
  });

  it("keeps reasoning enabled for MiniMax-M2.7", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.7");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(true);
  });

  it("preserves existing model params when adding alias", () => {
    const cfg = applyMinimaxApiConfig(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.7": {
                alias: "MiniMax",
                params: { custom: "value" },
              },
            },
          },
        },
      },
      "MiniMax-M2.7",
    );
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.7"]).toMatchObject({
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
    expect(cfg.models?.providers?.minimax?.authHeader).toBe(true);
    expect(cfg.models?.providers?.minimax?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
      "old-model",
      "MiniMax-M2.7",
    ]);
  });

  it("preserves other providers when adding minimax", () => {
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic-key", // pragma: allowlist secret
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
      // Default: general (non-coding) endpoint. Coding Plan endpoint is detected during setup.
      baseUrl: ZAI_GLOBAL_BASE_URL,
      api: "openai-completions",
    });
    const ids = cfg.models?.providers?.zai?.models?.map((m) => m.id);
    expect(ids).toContain("glm-5");
    expect(ids).toContain("glm-5-turbo");
    expect(ids).toContain("glm-4.7");
    expect(ids).toContain("glm-4.7-flash");
    expect(ids).toContain("glm-4.7-flashx");
  });

  it("supports CN endpoint for supported coding models", () => {
    for (const modelId of ["glm-4.7-flash", "glm-4.7-flashx"] as const) {
      const cfg = applyZaiConfig({}, { endpoint: "coding-cn", modelId });
      expect(cfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
      expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(`zai/${modelId}`);
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
        getConfig: () => applyMinimaxApiConfig({}, "MiniMax-M2.7-highspeed"),
        primaryModel: "minimax/MiniMax-M2.7-highspeed",
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
      expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(primaryModel);
    }
  });
});

describe("applyXiaomiConfig", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    expect(cfg.models?.providers?.xiaomi).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("xiaomi/mimo-v2-flash");
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

    expect(cfg.models?.providers?.xiaomi?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(cfg.models?.providers?.xiaomi?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.xiaomi?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
  });
});

describe("applyXaiConfig", () => {
  it("adds xAI provider with correct settings", () => {
    const cfg = applyXaiConfig({});
    expect(cfg.models?.providers?.xai).toMatchObject({
      baseUrl: "https://api.x.ai/v1",
      api: "openai-responses",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(XAI_DEFAULT_MODEL_REF);
  });
});

describe("applyXaiProviderConfig", () => {
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
    expect(cfg.models?.providers?.xai?.api).toBe("openai-responses");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "custom-model",
        "grok-4",
        "grok-4-1-fast",
        "grok-4.20-beta-latest-reasoning",
        "grok-code-fast-1",
      ]),
    );
  });
});

describe("applyMistralConfig", () => {
  it("adds Mistral provider with correct settings", () => {
    const cfg = applyMistralConfig({});
    expect(cfg.models?.providers?.mistral).toMatchObject({
      baseUrl: "https://api.mistral.ai/v1",
      api: "openai-completions",
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      MISTRAL_DEFAULT_MODEL_REF,
    );
  });
});

describe("applyMistralProviderConfig", () => {
  it("merges Mistral models and keeps existing provider overrides", () => {
    const cfg = applyMistralProviderConfig(
      createLegacyProviderConfig({
        providerId: "mistral",
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.mistral?.baseUrl).toBe("https://api.mistral.ai/v1");
    expect(cfg.models?.providers?.mistral?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.mistral?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.mistral?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mistral-large-latest",
    ]);
    const mistralDefault = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === "mistral-large-latest",
    );
    expect(mistralDefault?.contextWindow).toBe(262144);
    expect(mistralDefault?.maxTokens).toBe(16384);
  });

  it("uses the bundled mistral default model definition", () => {
    const bundled = buildBundledMistralModelDefinition();
    const cfg = applyMistralProviderConfig({});
    const defaultModel = cfg.models?.providers?.mistral?.models.find(
      (model) => model.id === bundled.id,
    );

    expect(defaultModel).toMatchObject({
      id: bundled.id,
      contextWindow: bundled.contextWindow,
      maxTokens: bundled.maxTokens,
    });
  });
});

describe("fallback preservation helpers", () => {
  it("preserves existing model fallbacks", () => {
    const fallbackCases = [applyMinimaxApiConfig, applyXaiConfig, applyMistralConfig] as const;
    for (const applyConfig of fallbackCases) {
      const cfg = applyConfig(createConfigWithFallbacks());
      expectFallbacksPreserved(cfg);
    }
  });
});

describe("provider alias defaults", () => {
  it("adds expected alias for provider defaults", () => {
    const aliasCases = [
      {
        applyConfig: () => applyMinimaxApiConfig({}, "MiniMax-M2.7"),
        modelRef: "minimax/MiniMax-M2.7",
        alias: "Minimax",
      },
      {
        applyConfig: () => applyXaiProviderConfig({}),
        modelRef: XAI_DEFAULT_MODEL_REF,
        alias: "Grok",
      },
      {
        applyConfig: () => applyMistralProviderConfig({}),
        modelRef: MISTRAL_DEFAULT_MODEL_REF,
        alias: "Mistral",
      },
    ] as const;
    for (const testCase of aliasCases) {
      const cfg = testCase.applyConfig();
      expect(cfg.agents?.defaults?.models?.[testCase.modelRef]?.alias).toBe(testCase.alias);
    }
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
        applyConfig: applyOpencodeGoProviderConfig,
        modelRef: "opencode-go/kimi-k2.5",
        alias: "Kimi",
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
        applyConfig: applyOpencodeGoConfig,
        primaryModel: "opencode-go/kimi-k2.5",
      },
      {
        applyConfig: applyOpenrouterConfig,
        primaryModel: OPENROUTER_DEFAULT_MODEL_REF,
      },
    ] as const;
    for (const { applyConfig, primaryModel } of configCases) {
      const cfg = applyConfig({});
      expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(primaryModel);

      const cfgWithFallbacks = applyConfig(createConfigWithFallbacks());
      expectFallbacksPreserved(cfgWithFallbacks);
    }
  });
});
