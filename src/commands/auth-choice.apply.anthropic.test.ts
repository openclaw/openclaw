import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("configures Azure Claude when anthropic-azure auth choice is selected", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter({
      note: vi.fn(async () => {}),
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAnthropic({
      authChoice: "anthropic-azure-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      agentDir,
      opts: {
        anthropicAzureApiKey: "azk-test", // pragma: allowlist secret
        anthropicAzureBaseUrl: "fabric-hub",
        anthropicAzureModelId: "claude-opus-4-6",
      },
    });

    expect(result?.config.auth?.profiles?.["anthropic-azure:default"]).toMatchObject({
      provider: "anthropic-azure",
      mode: "api_key",
    });
    expect(result?.config.models?.providers?.["anthropic-azure"]?.baseUrl).toBe(
      "https://fabric-hub.services.ai.azure.com/anthropic",
    );
    expect(result?.config.agents?.defaults?.model?.primary).toBe("anthropic-azure/claude-opus-4-6");

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; metadata?: Record<string, string> }>;
    }>(agentDir);
    expect(parsed.profiles?.["anthropic-azure:default"]).toMatchObject({
      key: "azk-test",
      metadata: {
        baseUrl: "https://fabric-hub.services.ai.azure.com/anthropic",
        modelId: "claude-opus-4-6",
        resource: "fabric-hub",
      },
    });
  });
});
