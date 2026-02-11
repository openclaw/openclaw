import type { OAuthCredentials } from "@mariozechner/pi-ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  OPENROUTER_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_MODEL_REF,
  XAI_DEFAULT_MODEL_REF,
  setMinimaxApiKey,
  writeOAuthCredentials,
} from "./onboard-auth.js";

const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");
const requireAgentDir = () => {
  const agentDir = process.env.OPENCLAW_AGENT_DIR;
  if (!agentDir) {
    throw new Error("OPENCLAW_AGENT_DIR not set");
  }
  return agentDir;
};

describe("writeOAuthCredentials", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    delete process.env.OPENCLAW_OAUTH_DIR;
  });

  it("writes auth-profiles.json under OPENCLAW_AGENT_DIR when set", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-oauth-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds);

    const authProfilePath = authProfilePathFor(requireAgentDir());
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    };
    expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
      refresh: "refresh-token",
      access: "access-token",
      type: "oauth",
    });

    await expect(
      fs.readFile(path.join(tempStateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
    ).rejects.toThrow();
  });
});

describe("setMinimaxApiKey", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
  });

  it("writes to OPENCLAW_AGENT_DIR when set", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-minimax-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_AGENT_DIR = path.join(tempStateDir, "custom-agent");
    process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;

    await setMinimaxApiKey("sk-minimax-test");

    const customAuthPath = authProfilePathFor(requireAgentDir());
    const raw = await fs.readFile(customAuthPath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
    };
    expect(parsed.profiles?.["minimax:default"]).toMatchObject({
      type: "api_key",
      provider: "minimax",
      key: "sk-minimax-test",
    });

    await expect(
      fs.readFile(path.join(tempStateDir, "agents", "main", "agent", "auth-profiles.json"), "utf8"),
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

  it("sets correct primary model", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1-lightning");
    expect(cfg.agents?.defaults?.model?.primary).toBe("minimax/MiniMax-M2.1-lightning");
  });

  it("does not set reasoning for non-reasoning models", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(false);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyMinimaxApiConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
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
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          minimax: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "openai-completions",
            models: [
              {
                id: "old-model",
                name: "Old",
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
    });
    expect(cfg.models?.providers?.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
    expect(cfg.models?.providers?.minimax?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.minimax?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
      "old-model",
      "MiniMax-M2.1",
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

describe("applyMinimaxApiProviderConfig", () => {
  it("does not overwrite existing primary model", () => {
    const cfg = applyMinimaxApiProviderConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
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

  it("sets correct primary model", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(SYNTHETIC_DEFAULT_MODEL_REF);
  });

  it("merges existing synthetic provider models", () => {
    const cfg = applySyntheticProviderConfig({
      models: {
        providers: {
          synthetic: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "openai-completions",
            models: [
              {
                id: "old-model",
                name: "Old",
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
    });
    expect(cfg.models?.providers?.synthetic?.baseUrl).toBe("https://api.synthetic.new/anthropic");
    expect(cfg.models?.providers?.synthetic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.synthetic?.apiKey).toBe("old-key");
    const ids = cfg.models?.providers?.synthetic?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_ID);
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
    const cfg = applyXiaomiProviderConfig({
      models: {
        providers: {
          xiaomi: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "openai-completions",
            models: [
              {
                id: "custom-model",
                name: "Custom",
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
    });

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
    const cfg = applyXaiConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
  });
});

describe("applyXaiProviderConfig", () => {
  it("adds model alias", () => {
    const cfg = applyXaiProviderConfig({});
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("merges xAI models and keeps existing provider overrides", () => {
    const cfg = applyXaiProviderConfig({
      models: {
        providers: {
          xai: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "anthropic-messages",
            models: [
              {
                id: "custom-model",
                name: "Custom",
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
    });

    expect(cfg.models?.providers?.xai?.baseUrl).toBe("https://api.x.ai/v1");
    expect(cfg.models?.providers?.xai?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.xai?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xai?.models.map((m) => m.id)).toEqual(["custom-model", "grok-4"]);
  });
});

describe("applyOpencodeZenProviderConfig", () => {
  it("adds allowlist entry for the default model", () => {
    const cfg = applyOpencodeZenProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain("opencode/claude-opus-4-6");
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyOpencodeZenProviderConfig({
      agents: {
        defaults: {
          models: {
            "opencode/claude-opus-4-6": { alias: "My Opus" },
          },
        },
      },
    });
    expect(cfg.agents?.defaults?.models?.["opencode/claude-opus-4-6"]?.alias).toBe("My Opus");
  });
});

describe("applyOpencodeZenConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyOpencodeZenConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe("opencode/claude-opus-4-6");
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyOpencodeZenConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
  });
});

describe("applyOpenrouterProviderConfig", () => {
  it("adds allowlist entry for the default model", () => {
    const cfg = applyOpenrouterProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain(OPENROUTER_DEFAULT_MODEL_REF);
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyOpenrouterProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENROUTER_DEFAULT_MODEL_REF]: { alias: "Router" },
          },
        },
      },
    });
    expect(cfg.agents?.defaults?.models?.[OPENROUTER_DEFAULT_MODEL_REF]?.alias).toBe("Router");
  });
});

describe("applyLitellmProviderConfig", () => {
  it("preserves existing baseUrl and api key while adding the default model", () => {
    const cfg = applyLitellmProviderConfig({
      models: {
        providers: {
          litellm: {
            baseUrl: "https://litellm.example/v1",
            apiKey: "  old-key  ",
            api: "anthropic-messages",
            models: [
              {
                id: "custom-model",
                name: "Custom",
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
    });

    expect(cfg.models?.providers?.litellm?.baseUrl).toBe("https://litellm.example/v1");
    expect(cfg.models?.providers?.litellm?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.litellm?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.litellm?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "claude-opus-4-6",
    ]);
  });
});

describe("applyOpenrouterConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyOpenrouterConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(OPENROUTER_DEFAULT_MODEL_REF);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyOpenrouterConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
  });
});
