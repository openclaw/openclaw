import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthChoiceAzureOpenAI } from "./auth-choice.apply.azure-openai.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("applyAuthChoiceAzureOpenAI", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "AZURE_OPENAI_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-azure-openai-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("applies Azure OpenAI auth + provider config from options", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAzureOpenAI({
      authChoice: "azure-openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        azureOpenaiApiKey: "azure-key",
        azureOpenaiBaseUrl: "https://example.openai.azure.com",
        azureOpenaiModelId: "gpt-5.4",
        azureOpenaiApiVersion: "2025-04-01-preview",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["azure-openai-responses:default"]).toMatchObject({
      provider: "azure-openai-responses",
      mode: "api_key",
    });
    expect(result?.config.models?.providers?.["azure-openai-responses"]).toMatchObject({
      baseUrl: "https://example.openai.azure.com/openai/v1",
      api: "openai-responses",
    });
    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "azure-openai-responses/gpt-5.4",
    });
    expect(
      result?.config.agents?.defaults?.models?.["azure-openai-responses/gpt-5.4"]?.params,
    ).toMatchObject({
      azureApiVersion: "2025-04-01-preview",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["azure-openai-responses:default"]?.key).toBe("azure-key");
    expect(parsed.profiles?.["azure-openai-responses:default"]?.keyRef).toBeUndefined();
  });

  it("writes env-backed Azure key as keyRef in ref mode", async () => {
    const agentDir = await setupTempState();
    process.env.AZURE_OPENAI_API_KEY = "azure-env-key";
    const confirm = vi.fn(async () => true);
    const prompter = createWizardPrompter({ confirm }, { defaultSelect: "ref" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAzureOpenAI({
      authChoice: "azure-openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
        azureOpenaiModelId: "gpt-4.1",
      },
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["azure-openai-responses:default"]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: "AZURE_OPENAI_API_KEY" },
    });
    expect(parsed.profiles?.["azure-openai-responses:default"]?.key).toBeUndefined();
    expect(
      result?.config.agents?.defaults?.models?.["azure-openai-responses/gpt-4.1"]?.params,
    ).toEqual({});
  });

  it("reuses AZURE_OPENAI_API_KEY from env in plaintext mode when confirmed", async () => {
    await setupTempState();
    process.env.AZURE_OPENAI_API_KEY = "azure-env-key";
    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "should-not-be-used");
    const prompter = createWizardPrompter({ confirm, text }, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAzureOpenAI({
      authChoice: "azure-openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
        azureOpenaiModelId: "gpt-4.1",
      },
    });

    expect(result).not.toBeNull();
    expect(confirm).toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });
  it("persists model params azureApiVersion when provided in opts", async () => {
    await setupTempState();
    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAzureOpenAI({
      authChoice: "azure-openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        azureOpenaiApiKey: "azure-key",
        azureOpenaiBaseUrl: "https://example.openai.azure.com/openai/v1",
        azureOpenaiModelId: "gpt-5.4",
        azureOpenaiApiVersion: "2025-04-01-preview",
      },
    });

    expect(
      result?.config.agents?.defaults?.models?.["azure-openai-responses/gpt-5.4"]?.params,
    ).toMatchObject({
      azureApiVersion: "2025-04-01-preview",
    });
  });

  it("does not persist Azure key when opts base URL validation fails", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    await expect(
      applyAuthChoiceAzureOpenAI({
        authChoice: "azure-openai-api-key",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
        opts: {
          azureOpenaiApiKey: "azure-key",
          azureOpenaiBaseUrl: "https://example.com",
          azureOpenaiModelId: "gpt-5.4",
        },
      }),
    ).rejects.toThrow(/Azure OpenAI base URL must use an Azure host/i);

    await expect(readAuthProfilesForAgent(agentDir)).rejects.toThrow();
  });
});
