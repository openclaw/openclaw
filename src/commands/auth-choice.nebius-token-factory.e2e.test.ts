import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice } from "./auth-choice.js";
import {
  NEBIUS_TOKEN_FACTORY_BASE_URL,
  NEBIUS_TOKEN_FACTORY_DEFAULT_MODEL_REF,
} from "./onboard-auth.models.js";
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

describe("applyAuthChoice (nebius-token-factory)", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "NEBIUS_TOKEN_FACTORY",
    "NEBIUS_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-auth-");
    lifecycle.setStateDir(env.stateDir);
    delete process.env.NEBIUS_TOKEN_FACTORY;
    delete process.env.NEBIUS_API_KEY;
  }

  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string }>;
    }>(requireOpenClawAgentDir());
  }

  async function runNebiusFlow(params: {
    config: Record<string, unknown>;
    setDefaultModel: boolean;
  }) {
    const text = vi.fn().mockResolvedValue("sk-nebius-test");
    const prompter = createPrompter({ text: text as unknown as WizardPrompter["text"] });
    const runtime = createExitThrowingRuntime();
    const result = await applyAuthChoice({
      authChoice: "nebius-token-factory-api-key",
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

  it("keeps the configured model when setDefaultModel is false", async () => {
    await setupTempState();

    const { result, text } = await runNebiusFlow({
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
      expect.objectContaining({ message: "Enter Nebius Token Factory API key" }),
    );
    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(result.config.models?.providers?.["nebius-token-factory"]?.baseUrl).toBe(
      NEBIUS_TOKEN_FACTORY_BASE_URL,
    );
    expect(result.agentModelOverride).toBe(NEBIUS_TOKEN_FACTORY_DEFAULT_MODEL_REF);

    const parsed = await readAuthProfiles();
    expect(parsed.profiles?.["nebius-token-factory:default"]?.key).toBe("sk-nebius-test");
  });

  it("sets the default model when setDefaultModel is true", async () => {
    await setupTempState();

    const { result } = await runNebiusFlow({
      config: {},
      setDefaultModel: true,
    });

    expect(result.config.agents?.defaults?.model?.primary).toBe(
      NEBIUS_TOKEN_FACTORY_DEFAULT_MODEL_REF,
    );
    expect(result.config.models?.providers?.["nebius-token-factory"]?.baseUrl).toBe(
      NEBIUS_TOKEN_FACTORY_BASE_URL,
    );
    expect(result.agentModelOverride).toBeUndefined();

    const parsed = await readAuthProfiles();
    expect(parsed.profiles?.["nebius-token-factory:default"]?.key).toBe("sk-nebius-test");
  });
});
