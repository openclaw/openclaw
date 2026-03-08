import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveConfigDir } from "../utils.js";
import { applyAuthChoiceOpenAI } from "./auth-choice.apply.openai.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

/**
 * QVeris flow: OpenAI API key is saved via upsertSharedEnvVar (launchd compatibility),
 * not to auth-profiles.json. Read the shared .env to verify.
 */
function readSharedEnvKey(stateDir: string, key: string): string | undefined {
  const configDir = resolveConfigDir({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
  const envPath = path.join(configDir, ".env");
  if (!fs.existsSync(envPath)) {
    return undefined;
  }
  const raw = fs.readFileSync(envPath, "utf8");
  const match = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
  return match ? match[1]?.trim() : undefined;
}

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
    return env;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("copies env-backed OpenAI key to shared .env for launchd compatibility", async () => {
    const { stateDir } = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env";

    const confirm = vi.fn(async () => true);
    const text = vi.fn(async () => "unused");
    const prompter = createWizardPrompter({ confirm, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    const defaultModel = result?.config.agents?.defaults?.model;
    const primaryModel = typeof defaultModel === "string" ? defaultModel : defaultModel?.primary;
    expect(primaryModel).toBe("openai/gpt-5.1-codex");
    expect(text).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalled();

    const savedKey = readSharedEnvKey(stateDir, "OPENAI_API_KEY");
    expect(savedKey).toBe("sk-openai-env");
  });

  it("writes env-backed OpenAI key as keyRef when secret-input-mode=ref", async () => {
    const { agentDir, stateDir } = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

    const prompter = createWizardPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        secretInputMode: "ref",
      },
    });

    expect(result).not.toBeNull();
    expect(readSharedEnvKey(stateDir, "OPENAI_API_KEY")).toBeUndefined();
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

  it("writes explicit token input to shared .env", async () => {
    const { stateDir } = await setupTempState();

    const prompter = createWizardPrompter({});
    const runtime = createExitThrowingRuntime();

    await applyAuthChoiceOpenAI({
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

    const savedKey = readSharedEnvKey(stateDir, "OPENAI_API_KEY");
    expect(savedKey).toBe("sk-openai-token");
  });

  it("prompts for key when env is empty and no opts.token", async () => {
    const { stateDir } = await setupTempState();
    delete process.env.OPENAI_API_KEY;

    const text = vi.fn(async () => "sk-entered-key");
    const prompter = createWizardPrompter({ text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: "Enter OpenAI API key" }));

    const savedKey = readSharedEnvKey(stateDir, "OPENAI_API_KEY");
    expect(savedKey).toBe("sk-entered-key");
  });
});
