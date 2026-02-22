import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceHuggingface } from "./auth-choice.apply.huggingface.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function createHuggingfacePrompter(params: {
  text: WizardPrompter["text"];
  select: WizardPrompter["select"];
  confirm?: WizardPrompter["confirm"];
  note?: WizardPrompter["note"];
}): WizardPrompter {
  const overrides: Partial<WizardPrompter> = {
    text: params.text,
    select: params.select,
  };
  if (params.confirm) {
    overrides.confirm = params.confirm;
  }
  if (params.note) {
    overrides.note = params.note;
  }
  return createWizardPrompter(overrides, { defaultSelect: "" });
}

describe("applyAuthChoiceHuggingface", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-hf-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  async function readAuthProfiles(agentDir: string) {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string }>;
    }>(agentDir);
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("returns null when authChoice is not huggingface-api-key", async () => {
    const result = await applyAuthChoiceHuggingface({
      authChoice: "openrouter-api-key",
      config: {},
      prompter: {} as WizardPrompter,
      runtime: createExitThrowingRuntime(),
      setDefaultModel: false,
    });
    expect(result).toBeNull();
  });

  it("prompts for key and model, then writes config and auth profile", async () => {
    const agentDir = await setupTempState();

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

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["huggingface:default"]?.key).toBe("hf-test-token");
  });

  it.each([
    {
      caseName: "does not prompt to reuse env token when opts.token already provided",
      tokenProvider: "huggingface",
      token: "hf-opts-token",
      envToken: "hf-env-token",
    },
    {
      caseName: "accepts mixed-case tokenProvider from opts without prompting",
      tokenProvider: "  HuGgInGfAcE  ",
      token: "hf-opts-mixed",
      envToken: undefined,
    },
  ])("$caseName", async ({ tokenProvider, token, envToken }) => {
    const agentDir = await setupTempState();
    if (envToken) {
      process.env.HF_TOKEN = envToken;
    } else {
      delete process.env.HF_TOKEN;
    }
    delete process.env.HUGGINGFACE_HUB_TOKEN;

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
        tokenProvider,
        token,
      },
    });

    expect(result).not.toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["huggingface:default"]?.key).toBe(token);
  });

  it("notes when selected Hugging Face model uses a locked router policy", async () => {
    await setupTempState();
    delete process.env.HF_TOKEN;
    delete process.env.HUGGINGFACE_HUB_TOKEN;

    const text = vi.fn().mockResolvedValue("hf-test-token");
    const select: WizardPrompter["select"] = vi.fn(async (params) => {
      const options = (params.options ?? []) as Array<{ value: string }>;
      const cheapest = options.find((option) => option.value.endsWith(":cheapest"));
      return (cheapest?.value ?? options[0]?.value ?? "") as never;
    });
    const note: WizardPrompter["note"] = vi.fn(async () => {});
    const prompter = createHuggingfacePrompter({ text, select, note });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceHuggingface({
      authChoice: "huggingface-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(String(result?.config.agents?.defaults?.model?.primary)).toContain(":cheapest");
    expect(note).toHaveBeenCalledWith(
      "Provider locked — router will choose backend by cost or speed.",
      "Hugging Face",
    );
  });
});
