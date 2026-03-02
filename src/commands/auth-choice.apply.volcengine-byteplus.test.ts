import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAuthChoiceBytePlus } from "./auth-choice.apply.byteplus.js";
import { applyAuthChoiceVolcengine } from "./auth-choice.apply.volcengine.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

describe("volcengine/byteplus auth choice", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "VOLCANO_ENGINE_API_KEY",
    "BYTEPLUS_API_KEY",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-volc-byte-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  function createTestContext(defaultSelect: string, confirmResult = true, textValue = "unused") {
    return {
      prompter: createWizardPrompter(
        {
          confirm: vi.fn(async () => confirmResult),
          text: vi.fn(async () => textValue),
        },
        { defaultSelect },
      ),
      runtime: createExitThrowingRuntime(),
    };
  }

  type ProviderAuthCase = {
    provider: "volcengine" | "byteplus";
    authChoice: "volcengine-api-key" | "byteplus-api-key";
    envVar: "VOLCANO_ENGINE_API_KEY" | "BYTEPLUS_API_KEY";
    envValue: string;
    profileId: "volcengine:default" | "byteplus:default";
    applyAuthChoice: typeof applyAuthChoiceVolcengine | typeof applyAuthChoiceBytePlus;
  };

  async function runProviderAuthChoice(
    testCase: ProviderAuthCase,
    options?: {
      defaultSelect?: string;
      confirmResult?: boolean;
      textValue?: string;
      secretInputMode?: "ref";
    },
  ) {
    const agentDir = await setupTempState();
    process.env[testCase.envVar] = testCase.envValue;

    const { prompter, runtime } = createTestContext(
      options?.defaultSelect ?? "plaintext",
      options?.confirmResult ?? true,
      options?.textValue ?? "unused",
    );

    const result = await testCase.applyAuthChoice({
      authChoice: testCase.authChoice,
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      ...(options?.secretInputMode ? { opts: { secretInputMode: options.secretInputMode } } : {}),
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);

    return { result, parsed };
  }

  const providerAuthCases: ProviderAuthCase[] = [
    {
      provider: "volcengine",
      authChoice: "volcengine-api-key",
      envVar: "VOLCANO_ENGINE_API_KEY",
      envValue: "volc-env-key",
      profileId: "volcengine:default",
      applyAuthChoice: applyAuthChoiceVolcengine,
    },
    {
      provider: "byteplus",
      authChoice: "byteplus-api-key",
      envVar: "BYTEPLUS_API_KEY",
      envValue: "byte-env-key",
      profileId: "byteplus:default",
      applyAuthChoice: applyAuthChoiceBytePlus,
    },
  ];

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it.each(providerAuthCases)(
    "stores $provider env key as plaintext by default",
    async (testCase) => {
      const { result, parsed } = await runProviderAuthChoice(testCase);
      expect(result).not.toBeNull();
      expect(result?.config.auth?.profiles?.[testCase.profileId]).toMatchObject({
        provider: testCase.provider,
        mode: "api_key",
      });
      expect(parsed.profiles?.[testCase.profileId]?.key).toBe(testCase.envValue);
      expect(parsed.profiles?.[testCase.profileId]?.keyRef).toBeUndefined();
    },
  );

  it.each(providerAuthCases)("stores $provider env key as keyRef in ref mode", async (testCase) => {
    const { result, parsed } = await runProviderAuthChoice(testCase, {
      defaultSelect: "ref",
    });
    expect(result).not.toBeNull();
    expect(parsed.profiles?.[testCase.profileId]).toMatchObject({
      keyRef: { source: "env", provider: "default", id: testCase.envVar },
    });
    expect(parsed.profiles?.[testCase.profileId]?.key).toBeUndefined();
  });

  it("stores explicit volcengine key when env is not used", async () => {
    const { result, parsed } = await runProviderAuthChoice(providerAuthCases[0], {
      defaultSelect: "",
      confirmResult: false,
      textValue: "volc-manual-key",
    });
    expect(result).not.toBeNull();
    expect(parsed.profiles?.["volcengine:default"]?.key).toBe("volc-manual-key");
    expect(parsed.profiles?.["volcengine:default"]?.keyRef).toBeUndefined();
  });
});
