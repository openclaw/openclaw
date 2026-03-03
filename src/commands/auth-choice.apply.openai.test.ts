import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { upsertAuthProfile } from "../agents/auth-profiles.js";
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

  it("reuses stored OpenAI profile key when reconfiguring models", async () => {
    const agentDir = await setupTempState();
    delete process.env.OPENAI_API_KEY;

    const seedPrompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();
    const seeded = await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter: seedPrompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "openai",
        token: "sk-openai-seeded",
      },
    });
    expect(seeded).not.toBeNull();

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "should-not-be-used");
    const reconfigurePrompter = createWizardPrompter(
      { confirm, text },
      { defaultSelect: "plaintext" },
    );
    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: seeded?.config ?? {},
      prompter: reconfigurePrompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("profile:openai:default"),
      }),
    );
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBe("sk-openai-seeded");
    expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });

  it("prompts for a new key when the user declines reusing existing OpenAI credentials", async () => {
    const agentDir = await setupTempState();
    delete process.env.OPENAI_API_KEY;

    const runtime = createExitThrowingRuntime();
    const seedPrompter = createWizardPrompter({}, { defaultSelect: "" });
    const seeded = await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter: seedPrompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "openai",
        token: "sk-openai-old",
      },
    });
    expect(seeded).not.toBeNull();

    const confirm = vi.fn(async () => false);
    const text = vi.fn(async () => "sk-openai-new");
    const reconfigurePrompter = createWizardPrompter(
      { confirm, text },
      { defaultSelect: "plaintext" },
    );
    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: seeded?.config ?? {},
      prompter: reconfigurePrompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(confirm).toHaveBeenCalled();
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter OpenAI API key" }),
    );

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBe("sk-openai-new");
    expect(parsed.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });

  it("reuses credentials from the configured agentDir instead of default agent store", async () => {
    const defaultAgentDir = await setupTempState();
    delete process.env.OPENAI_API_KEY;
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    expect(stateDir).toBeTruthy();
    const secondaryAgentDir = path.join(String(stateDir), "agents", "secondary", "agent");
    await fs.mkdir(secondaryAgentDir, { recursive: true });

    const runtime = createExitThrowingRuntime();
    const seedPrompter = createWizardPrompter({}, { defaultSelect: "" });

    await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter: seedPrompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "openai",
        token: "sk-openai-default",
      },
      agentDir: defaultAgentDir,
    });

    const seededSecondary = await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter: seedPrompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "openai",
        token: "sk-openai-secondary",
      },
      agentDir: secondaryAgentDir,
    });
    expect(seededSecondary).not.toBeNull();

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "should-not-be-used");
    const reconfigurePrompter = createWizardPrompter(
      { confirm, text },
      { defaultSelect: "plaintext" },
    );
    await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: seededSecondary?.config ?? {},
      prompter: reconfigurePrompter,
      runtime,
      setDefaultModel: true,
      agentDir: secondaryAgentDir,
    });

    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();

    const parsedSecondary = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(secondaryAgentDir);
    expect(parsedSecondary.profiles?.["openai:default"]?.key).toBe("sk-openai-secondary");
    expect(parsedSecondary.profiles?.["openai:default"]?.keyRef).toBeUndefined();
  });

  it("keeps keyRef credentials when reusing stored OpenAI auth profile values", async () => {
    const agentDir = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-ref";

    const runtime = createExitThrowingRuntime();
    const seedPrompter = createWizardPrompter({}, { defaultSelect: "ref" });
    const seeded = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter: seedPrompter,
      runtime,
      setDefaultModel: true,
    });
    expect(seeded).not.toBeNull();
    const parsedSeeded = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsedSeeded.profiles?.["openai:default"]?.key).toBeUndefined();
    expect(parsedSeeded.profiles?.["openai:default"]?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "should-not-be-used");
    const reconfigurePrompter = createWizardPrompter(
      { confirm, text },
      { defaultSelect: "plaintext" },
    );
    await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: seeded?.config ?? {},
      prompter: reconfigurePrompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBeUndefined();
    expect(parsed.profiles?.["openai:default"]?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });

  it("preserves inline env-ref key strings when reusing OpenAI profile credentials", async () => {
    const agentDir = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-inline-ref";

    upsertAuthProfile({
      profileId: "openai:default",
      agentDir,
      credential: {
        type: "api_key",
        provider: "openai",
        key: "${OPENAI_API_KEY}",
      },
    });

    const runtime = createExitThrowingRuntime();
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "should-not-be-used");
    const reconfigurePrompter = createWizardPrompter(
      { confirm, text },
      { defaultSelect: "plaintext" },
    );
    await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter: reconfigurePrompter,
      runtime,
      setDefaultModel: true,
      agentDir,
    });

    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["openai:default"]?.key).toBeUndefined();
    expect(parsed.profiles?.["openai:default"]?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
  });
});
