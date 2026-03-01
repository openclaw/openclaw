import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice } from "./auth-choice.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return createWizardPrompter(overrides, { defaultSelect: "" });
}

describe("applyAuthChoice (stepfun)", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "STEPFUN_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-auth-");
    lifecycle.setStateDir(env.stateDir);
    delete process.env.STEPFUN_API_KEY;
  }

  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string }>;
    }>(requireOpenClawAgentDir());
  }

  async function runStepfunFlow(params: {
    authChoice: "stepfun-api-key" | "stepfun-cn";
    config: Record<string, unknown>;
    setDefaultModel: boolean;
  }) {
    const text = vi.fn().mockResolvedValue("sk-stepfun-test");
    const prompter = createPrompter({ text: text as unknown as WizardPrompter["text"] });
    const runtime = createExitThrowingRuntime();
    const result = await applyAuthChoice({
      authChoice: params.authChoice,
      config: params.config,
      prompter,
      runtime,
      setDefaultModel: params.setDefaultModel,
    });
    return { result, text };
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("keeps current model when setDefaultModel is false", async () => {
    await setupTempState();

    const { result, text } = await runStepfunFlow({
      authChoice: "stepfun-api-key",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter StepFun API key" }),
    );
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "anthropic/claude-opus-4-5",
    );
    expect(result.config.models?.providers?.stepfun?.baseUrl).toBe("https://api.stepfun.ai/v1");
    expect(result.agentModelOverride).toBe("stepfun/step-3.5-flash");

    const parsed = await readAuthProfiles();
    expect(parsed.profiles?.["stepfun:default"]?.key).toBe("sk-stepfun-test");
  });

  it("uses CN baseUrl when auth choice is stepfun-cn", async () => {
    await setupTempState();

    const { result } = await runStepfunFlow({
      authChoice: "stepfun-cn",
      config: {},
      setDefaultModel: true,
    });

    expect(result.config.models?.providers?.stepfun?.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(resolveAgentModelPrimaryValue(result.config.agents?.defaults?.model)).toBe(
      "stepfun/step-3.5-flash",
    );
  });

  it("keeps existing StepFun baseUrl when endpoint is not specified", async () => {
    await setupTempState();

    const { result } = await runStepfunFlow({
      authChoice: "stepfun-api-key",
      config: {
        models: {
          providers: {
            stepfun: {
              baseUrl: "https://api.stepfun.com/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
      setDefaultModel: false,
    });

    expect(result.config.models?.providers?.stepfun?.baseUrl).toBe("https://api.stepfun.com/v1");
  });
});
