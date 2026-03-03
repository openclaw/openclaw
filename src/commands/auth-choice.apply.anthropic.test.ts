import { afterEach, describe, expect, it } from "vitest";
import { applyAuthChoiceAnthropic } from "./auth-choice.apply.anthropic.js";
import { ANTHROPIC_SETUP_TOKEN_PREFIX } from "./auth-token.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("applyAuthChoiceAnthropic", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_SETUP_TOKEN",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-anthropic-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("persists setup-token ref without plaintext token in auth-profiles store", async () => {
    const agentDir = await setupTempState();
    process.env.ANTHROPIC_SETUP_TOKEN = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"x".repeat(100)}`;

    const prompter = createWizardPrompter({}, { defaultSelect: "ref" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAnthropic({
      authChoice: "setup-token",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "token",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { token?: string; tokenRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["anthropic:default"]?.token).toBeUndefined();
    expect(parsed.profiles?.["anthropic:default"]?.tokenRef).toMatchObject({
      source: "env",
      provider: "default",
      id: "ANTHROPIC_SETUP_TOKEN",
    });
  });
});
