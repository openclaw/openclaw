import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceModelScope } from "./auth-choice.apply.modelscope.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function createModelScopePrompter(params: {
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

type ApplyModelScopeParams = Parameters<typeof applyAuthChoiceModelScope>[0];

async function runModelScopeApply(
  params: Omit<ApplyModelScopeParams, "authChoice" | "setDefaultModel"> &
    Partial<Pick<ApplyModelScopeParams, "setDefaultModel">>,
) {
  return await applyAuthChoiceModelScope({
    authChoice: "modelscope-api-key",
    setDefaultModel: params.setDefaultModel ?? true,
    ...params,
  });
}

describe("applyAuthChoiceModelScope", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    // ModelScope 不使用标准 env var，但保留清理
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-modelscope-");
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

  it("returns null when authChoice is not modelscope-api-key", async () => {
    const result = await applyAuthChoiceModelScope({
      authChoice: "openai-api-key",
      config: {},
      prompter: {} as WizardPrompter,
      runtime: createExitThrowingRuntime(),
      setDefaultModel: false,
    });
    expect(result).toBeNull();
  });

  it("prompts for key and model, then writes config and auth profile", async () => {
    const agentDir = await setupTempState();

    const text = vi.fn().mockResolvedValue("ms-test-key");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options?.[0]?.value as never,
    );
    const prompter = createModelScopePrompter({ text, select });
    const runtime = createExitThrowingRuntime();

    // Mock discoverModelScopeModels to return fake models
    vi.doMock("../agents/modelscope-models.js", () => ({
      discoverModelScopeModels: vi.fn().mockResolvedValue([
        { id: "qwen-max", name: "Qwen-Max" },
        { id: "qwen-plus", name: "Qwen-Plus" },
      ]),
    }));

    const result = await runModelScopeApply({
      config: {},
      prompter,
      runtime,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["modelscope:default"]).toMatchObject({
      provider: "modelscope",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toMatch(
      /^modelscope\/.+/,
    );
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ModelScope API key") }),
    );
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Default ModelScope model" }),
    );

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["modelscope:default"]?.key).toBe("ms-test-key");
  });

  it("does not prompt when opts.token is provided", async () => {
    const agentDir = await setupTempState();

    const text = vi.fn().mockResolvedValue("should-not-be-called");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options?.[0]?.value as never,
    );
    const prompter = createModelScopePrompter({ text, select });
    const runtime = createExitThrowingRuntime();

    vi.doMock("../agents/modelscope-models.js", () => ({
      discoverModelScopeModels: vi
        .fn()
        .mockResolvedValue([{ id: "qwen-turbo", name: "Qwen-Turbo" }]),
    }));

    const result = await runModelScopeApply({
      config: {},
      prompter,
      runtime,
      opts: {
        tokenProvider: "modelscope",
        token: "ms-opts-key",
      },
    });

    expect(result).not.toBeNull();
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["modelscope:default"]?.key).toBe("ms-opts-key");
  });
});
