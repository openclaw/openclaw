import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("applyAuthChoiceOpenAI", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "OPENAI_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-openai-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("writes env-backed OpenAI key as plaintext by default", async () => {
    const agentDir = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env";

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "unused");
    const prompter = createWizardPrompter({ confirm, text }, { defaultSelect: "plaintext" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["openai:default"]).toMatchObject({
      provider: "openai",
      mode: "api_key",
    });
    const defaultModel = result?.config.agents?.defaults?.model;
    const primaryModel = typeof defaultModel === "string" ? defaultModel : defaultModel?.primary;
    expect(primaryModel).toBe("openai/gpt-5.1-codex");
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBe("sk-openai-env");
    expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });

  it("writes env-backed OpenAI key as keyRef when secret-input-mode=ref", async () => {
    const agentDir = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env";

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "unused");
    const prompter = createWizardPrompter({ confirm, text }, { defaultSelect: "ref" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
    });
    expect(parsed.profiles?.["openai:default"]?.key).toBeUndefined();
  });

  it("writes explicit token input into openai auth profile", async () => {
    const agentDir = await setupTempState();

    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "openai",
        token: "sk-openai-token",
      },
    });

    expect(result).not.toBeNull();

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBe("sk-openai-token");
    expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });
});
