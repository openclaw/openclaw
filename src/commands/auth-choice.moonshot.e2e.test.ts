import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice } from "./auth-choice.js";

const noopAsync = async () => {};
const noop = () => {};
const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");
const requireAgentDir = () => {
  const agentDir = process.env.OPENCLAW_AGENT_DIR;
  if (!agentDir) {
    throw new Error("OPENCLAW_AGENT_DIR not set");
  }
  return agentDir;
};

function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit:${code}`);
    }),
  };
}

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(noopAsync),
    outro: vi.fn(noopAsync),
    note: vi.fn(noopAsync),
    select: vi.fn(async () => "" as never),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as unknown as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: noop, stop: noop })),
    ...overrides,
  };
}

describe("applyAuthChoice (moonshot)", () => {
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousMoonshotKey = process.env.MOONSHOT_API_KEY;
  let tempStateDir: string | null = null;

  async function setupTempState() {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auth-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    process.env.OPENCLAW_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.OPENCLAW_AGENT_DIR;
    delete process.env.MOONSHOT_API_KEY;
  }

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
    if (previousMoonshotKey === undefined) {
      delete process.env.MOONSHOT_API_KEY;
    } else {
      process.env.MOONSHOT_API_KEY = previousMoonshotKey;
    }
  });

  it("keeps the .cn baseUrl when setDefaultModel is false", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-moonshot-cn-test");
    const prompter = createPrompter({ text: text as unknown as WizardPrompter["text"] });
    const runtime = createRuntime();

    const result = await applyAuthChoice({
      authChoice: "moonshot-api-key-cn",
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
      expect.objectContaining({ message: "Enter Moonshot API key (.cn)" }),
    );
    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(result.config.models?.providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(result.agentModelOverride).toBe("moonshot/kimi-k2.5");

    const authProfilePath = authProfilePathFor(requireAgentDir());
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["moonshot:default"]?.key).toBe("sk-moonshot-cn-test");
  });

  it("sets the default model when setDefaultModel is true", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-moonshot-cn-test");
    const prompter = createPrompter({ text: text as unknown as WizardPrompter["text"] });
    const runtime = createRuntime();

    const result = await applyAuthChoice({
      authChoice: "moonshot-api-key-cn",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.agents?.defaults?.model?.primary).toBe("moonshot/kimi-k2.5");
    expect(result.config.models?.providers?.moonshot?.baseUrl).toBe("https://api.moonshot.cn/v1");
    expect(result.agentModelOverride).toBeUndefined();

    const authProfilePath = authProfilePathFor(requireAgentDir());
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["moonshot:default"]?.key).toBe("sk-moonshot-cn-test");
  });
});
