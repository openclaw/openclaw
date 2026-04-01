import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIMLAPI_BASE_URL,
  AIMLAPI_DEFAULT_MODEL_ID,
  buildAimlapiDefaultModelDefinition,
} from "../agents/aimlapi-models.js";
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithDefaultModel,
  type OpenClawConfig as ProviderOnboardConfig,
} from "../plugin-sdk/provider-onboard.js";
import { AIMLAPI_DEFAULT_MODEL_REF } from "../plugin-sdk/aimlapi.js";
import {
  applyAuthProfileConfig,
} from "../plugins/provider-auth-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { setMinimaxApiKey, writeOAuthCredentials } from "../plugins/provider-auth-storage.js";
import { resolveAgentModelFallbackValues, resolveAgentModelPrimaryValue } from "../config/model-input.js";
import {
  createAuthTestLifecycle,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function applyAimlapiProviderConfig(cfg: ProviderOnboardConfig): ProviderOnboardConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[AIMLAPI_DEFAULT_MODEL_REF] = {
    ...models[AIMLAPI_DEFAULT_MODEL_REF],
    alias: models[AIMLAPI_DEFAULT_MODEL_REF]?.alias ?? "AI/ML API",
  };

  return applyProviderConfigWithDefaultModel(cfg, {
    agentModels: models,
    providerId: "aimlapi",
    api: "openai-completions",
    baseUrl: AIMLAPI_BASE_URL,
    defaultModel: buildAimlapiDefaultModelDefinition(),
    defaultModelId: AIMLAPI_DEFAULT_MODEL_ID,
  });
}

function applyAimlapiConfig(cfg: ProviderOnboardConfig): ProviderOnboardConfig {
  return applyAgentDefaultModelPrimary(applyAimlapiProviderConfig(cfg), AIMLAPI_DEFAULT_MODEL_REF);
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

describe("applyAimlapiProviderConfig", () => {
  it("adds allowlist entry for the default model", () => {
    const cfg = applyAimlapiProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain(AIMLAPI_DEFAULT_MODEL_REF);
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyAimlapiProviderConfig({
      agents: {
        defaults: {
          models: {
            [AIMLAPI_DEFAULT_MODEL_REF]: { alias: "AIML" },
          },
        },
      },
    });
    expect(cfg.agents?.defaults?.models?.[AIMLAPI_DEFAULT_MODEL_REF]?.alias).toBe("AIML");
  });
});

describe("applyAimlapiConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyAimlapiConfig({});
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      AIMLAPI_DEFAULT_MODEL_REF,
    );
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyAimlapiConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(resolveAgentModelFallbackValues(cfg.agents?.defaults?.model)).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });
});
