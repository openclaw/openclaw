import { afterEach, describe, expect, it, vi } from "vitest";
import anthropicPlugin from "../../extensions/anthropic/index.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { registerSingleProviderPlugin } from "../test-utils/plugin-registration.js";
import { applyAuthChoiceAnthropic } from "./auth-choice.apply.anthropic.js";
import { applyAuthChoice } from "./auth-choice.js";
import { ANTHROPIC_SETUP_TOKEN_PREFIX } from "./auth-token.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

describe("applyAuthChoiceAnthropic", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_SETUP_TOKEN",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-anthropic-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  afterEach(async () => {
    resolvePluginProviders.mockReset();
    resolvePluginProviders.mockReturnValue([]);
    await lifecycle.cleanup();
  });

  it("writes env-backed Anthropic key as keyRef when secret-input-mode=ref", async () => {
    const agentDir = await setupTempState();
    process.env.ANTHROPIC_API_KEY = "sk-ant-api-key";

    const confirm = vi.fn(async () => true);
    const prompter = createWizardPrompter({ confirm }, { defaultSelect: "ref" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAnthropic({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["anthropic:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
    });
    expect(parsed.profiles?.["anthropic:default"]?.key).toBeUndefined();
  });

  it("routes token onboarding through the anthropic provider plugin", async () => {
    const agentDir = await setupTempState();
    process.env.ANTHROPIC_SETUP_TOKEN = `${ANTHROPIC_SETUP_TOKEN_PREFIX}${"x".repeat(100)}`;
    resolvePluginProviders.mockReturnValue([registerSingleProviderPlugin(anthropicPlugin)]);

    const select = vi.fn().mockResolvedValueOnce("env");
    const text = vi.fn().mockResolvedValueOnce("ANTHROPIC_SETUP_TOKEN").mockResolvedValueOnce("");
    const prompter = createWizardPrompter({ select, text }, { defaultSelect: "ref" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "token",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: { secretInputMode: "ref" },
    });

    expect(result.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
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
