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

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("stores volcengine env key as plaintext by default", async () => {
    const agentDir = await setupTempState();
    process.env.VOLCANO_ENGINE_API_KEY = "volc-env-key";

    const prompter = createWizardPrompter(
      {
        confirm: vi.fn(async () => true),
        text: vi.fn(async () => "unused"),
      },
      { defaultSelect: "plaintext" },
    );
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceVolcengine({
      authChoice: "volcengine-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["volcengine:default"]).toMatchObject({
      provider: "volcengine",
      mode: "api_key",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["volcengine:default"]?.key).toBe("volc-env-key");
    expect(parsed.profiles?.["volcengine:default"]?.keyRef).toBeUndefined();
  });

  it("stores volcengine env key as keyRef in ref mode", async () => {
    const agentDir = await setupTempState();
    process.env.VOLCANO_ENGINE_API_KEY = "volc-env-key";

    const prompter = createWizardPrompter(
      {
        confirm: vi.fn(async () => true),
        text: vi.fn(async () => "unused"),
      },
      { defaultSelect: "ref" },
    );
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceVolcengine({
      authChoice: "volcengine-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["volcengine:default"]).toMatchObject({
      keyRef: { source: "env", id: "VOLCANO_ENGINE_API_KEY" },
    });
    expect(parsed.profiles?.["volcengine:default"]?.key).toBeUndefined();
  });

  it("stores byteplus env key as plaintext by default", async () => {
    const agentDir = await setupTempState();
    process.env.BYTEPLUS_API_KEY = "byte-env-key";

    const prompter = createWizardPrompter(
      {
        confirm: vi.fn(async () => true),
        text: vi.fn(async () => "unused"),
      },
      { defaultSelect: "plaintext" },
    );
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceBytePlus({
      authChoice: "byteplus-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["byteplus:default"]).toMatchObject({
      provider: "byteplus",
      mode: "api_key",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["byteplus:default"]?.key).toBe("byte-env-key");
    expect(parsed.profiles?.["byteplus:default"]?.keyRef).toBeUndefined();
  });

  it("stores byteplus env key as keyRef in ref mode", async () => {
    const agentDir = await setupTempState();
    process.env.BYTEPLUS_API_KEY = "byte-env-key";

    const prompter = createWizardPrompter(
      {
        confirm: vi.fn(async () => true),
        text: vi.fn(async () => "unused"),
      },
      { defaultSelect: "ref" },
    );
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceBytePlus({
      authChoice: "byteplus-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["byteplus:default"]).toMatchObject({
      keyRef: { source: "env", id: "BYTEPLUS_API_KEY" },
    });
    expect(parsed.profiles?.["byteplus:default"]?.key).toBeUndefined();
  });

  it("stores explicit volcengine key when env is not used", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter(
      {
        confirm: vi.fn(async () => false),
        text: vi.fn(async () => "volc-manual-key"),
      },
      { defaultSelect: "" },
    );
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceVolcengine({
      authChoice: "volcengine-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: unknown }>;
    }>(agentDir);
    expect(parsed.profiles?.["volcengine:default"]?.key).toBe("volc-manual-key");
    expect(parsed.profiles?.["volcengine:default"]?.keyRef).toBeUndefined();
  });
});
