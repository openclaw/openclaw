import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthChoiceOpenRouter } from "./auth-choice.apply.openrouter.js";
import { setOpenrouterApiKey } from "./onboard-auth.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("applyAuthChoiceOpenRouter", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OPENROUTER_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-openrouter-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("prompts for API key even when an OpenRouter key already exists", async () => {
    const agentDir = await setupTempState();
    await setOpenrouterApiKey("old-openrouter-key", agentDir);

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "new-openrouter-key");
    const prompter = createWizardPrompter({ confirm, text }, { defaultSelect: "plaintext" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenRouter({
      authChoice: "openrouter-api-key",
      config: {
        auth: {
          profiles: {
            "openrouter:legacy": {
              provider: "openrouter",
              mode: "oauth",
            },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });
    expect(text).toHaveBeenCalledTimes(1);

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string }>;
    }>(agentDir);
    expect(parsed.profiles?.["openrouter:default"]?.key).toBe("new-openrouter-key");
  });
});
