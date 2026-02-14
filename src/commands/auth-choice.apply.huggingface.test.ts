import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";

const noopAsync = async () => {};
const noop = () => {};
const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");

describe("applyAuthChoiceHuggingface", () => {
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  const previousHfToken = process.env.HF_TOKEN;
  const previousHubToken = process.env.HUGGINGFACE_HUB_TOKEN;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
    if (previousHfToken === undefined) {
      delete process.env.HF_TOKEN;
    } else {
      process.env.HF_TOKEN = previousHfToken;
    }
    if (previousHubToken === undefined) {
      delete process.env.HUGGINGFACE_HUB_TOKEN;
    } else {
      process.env.HUGGINGFACE_HUB_TOKEN = previousHubToken;
    }
  });

  it("returns null when authChoice is not huggingface-api-key", async () => {
    const result = await applyAuthChoiceHuggingface({
      authChoice: "openrouter-api-key",
      config: {},
      prompter: {} as WizardPrompter,
      runtime: {} as RuntimeEnv,
      setDefaultModel: false,
    });
    expect(result).toBeNull();
  });

  it("prompts for key and model, then writes config and auth profile", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hf-"));
    const agentDir = path.join(tempStateDir, "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    await fs.mkdir(agentDir, { recursive: true });

    const text = vi.fn().mockResolvedValue("hf-test-token");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options?.[0]?.value as never,
    );
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect: vi.fn(async () => []),
      text,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoiceHuggingface({
      authChoice: "huggingface-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["huggingface:default"]).toMatchObject({
      provider: "huggingface",
      mode: "api_key",
    });
    expect(result?.config.agents?.defaults?.model?.primary).toMatch(/^huggingface\/.+/);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Hugging Face") }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Default Hugging Face model" }),
    );

    const authProfilePath = authProfilePathFor(agentDir);
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["huggingface:default"]?.key).toBe("hf-test-token");
  });

  it("does not prompt to reuse env token when opts.token already provided", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hf-"));
    const agentDir = path.join(tempStateDir, "agent");
    process.env.OPENCLAW_AGENT_DIR = agentDir;
    process.env.HF_TOKEN = "hf-env-token";
    delete process.env.HUGGINGFACE_HUB_TOKEN;
    await fs.mkdir(agentDir, { recursive: true });

    const text = vi.fn().mockResolvedValue("hf-text-token");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options?.[0]?.value as never,
    );
    const confirm = vi.fn(async () => true);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect: vi.fn(async () => []),
      text,
      confirm,
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoiceHuggingface({
      authChoice: "huggingface-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "huggingface",
        token: "hf-opts-token",
      },
    });

    expect(result).not.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();

    const authProfilePath = authProfilePathFor(agentDir);
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["huggingface:default"]?.key).toBe("hf-opts-token");
  });
});
