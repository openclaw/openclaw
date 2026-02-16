import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { captureEnv } from "../test-utils/env.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";
import { createExitThrowingRuntime, createWizardPrompter } from "./test-wizard-helpers.js";

const authProfilePathFor = (agentDir: string) => path.join(agentDir, "auth-profiles.json");

function createHuggingfacePrompter(params: {
  text: WizardPrompter["text"];
  select: WizardPrompter["select"];
  confirm?: WizardPrompter["confirm"];
}): WizardPrompter {
  const overrides: Partial<WizardPrompter> = {
    text: params.text,
    select: params.select,
  };
  if (params.confirm) {
    overrides.confirm = params.confirm;
  }
  return createWizardPrompter(overrides, { defaultSelect: "" });
}

describe("applyAuthChoiceHuggingface", () => {
  const envSnapshot = captureEnv(["OPENCLAW_AGENT_DIR", "HF_TOKEN", "HUGGINGFACE_HUB_TOKEN"]);
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    envSnapshot.restore();
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
    const prompter = createHuggingfacePrompter({ text, select });
    const runtime = createExitThrowingRuntime();

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
    const prompter = createHuggingfacePrompter({ text, select, confirm });
    const runtime = createExitThrowingRuntime();

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
