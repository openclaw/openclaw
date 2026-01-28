import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VOLCENGINE_API_BASE_URL } from "../agents/models-config.providers.js";
import {
  applyVolcengineConfig,
  applyVolcengineProviderConfig,
  setVolcengineApiKey,
} from "./onboard-auth.js";

const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");
const requireAgentDir = () => {
  const agentDir = process.env.OPENCLAW_AGENT_DIR;
  if (!agentDir) {
    throw new Error("OPENCLAW_AGENT_DIR not set");
  }
  return agentDir;
};

describe("setVolcengineApiKey", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
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
  });

  it("writes to OPENCLAW_AGENT_DIR when set", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-volcengine-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_AGENT_DIR = path.join(tempStateDir, "custom-agent");

    await setVolcengineApiKey("sk-volcengine-test");

    const customAuthPath = authProfilePathFor(requireAgentDir());
    const raw = await fs.readFile(customAuthPath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { type?: string; provider?: string; key?: string }>;
    };
    expect(parsed.profiles?.["volcengine:default"]).toMatchObject({
      type: "api_key",
      provider: "volcengine",
      key: "sk-volcengine-test",
    });
  });
});

describe("applyVolcengineConfig", () => {
  const TEST_MODEL_ID = "ep-20250604015609-b6g2q";

  it("adds Volcengine provider with correct settings", () => {
    const cfg = applyVolcengineConfig({}, TEST_MODEL_ID);
    expect(cfg.models?.providers?.volcengine).toMatchObject({
      baseUrl: VOLCENGINE_API_BASE_URL,
      api: "openai-completions",
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe(`volcengine/${TEST_MODEL_ID}`);
  });

  it("merges Volcengine models and keeps existing provider overrides", () => {
    const cfg = applyVolcengineProviderConfig(
      {
        models: {
          providers: {
            volcengine: {
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
      },
      TEST_MODEL_ID,
    );

    expect(cfg.models?.providers?.volcengine?.baseUrl).toBe(VOLCENGINE_API_BASE_URL);
    expect(cfg.models?.providers?.volcengine?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.volcengine?.apiKey).toBe("old-key");
    const modelIds = cfg.models?.providers?.volcengine?.models.map((m) => m.id);
    expect(modelIds).toContain("old-model");
    expect(modelIds).toContain(TEST_MODEL_ID);
  });

  it("preserves existing model params when adding alias", () => {
    const cfg = applyVolcengineConfig(
      {
        agents: {
          defaults: {
            models: {
              [`volcengine/${TEST_MODEL_ID}`]: {
                alias: "Volcengine Test",
                params: { custom: "value" },
              },
            },
          },
        },
      },
      TEST_MODEL_ID,
    );
    expect(cfg.agents?.defaults?.models?.[`volcengine/${TEST_MODEL_ID}`]).toMatchObject({
      alias: "Volcengine Test",
      params: { custom: "value" },
    });
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyVolcengineConfig(
      {
        agents: {
          defaults: {
            model: { fallbacks: ["anthropic/claude-opus-4-5"] },
          },
        },
      },
      TEST_MODEL_ID,
    );
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual(["anthropic/claude-opus-4-5"]);
  });
});
