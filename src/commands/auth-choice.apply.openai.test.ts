import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openAICodexOAuth from "./openai-codex-oauth.js";

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    getOAuthProviders: () => [
      { id: "openai-codex", envApiKey: "OPENAI_API_KEY", oauthTokenEnv: "OPENAI_OAUTH_TOKEN" }, // pragma: allowlist secret
    ],
  };
});

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
    "CODEX_HOME",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-openai-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  async function writeCodexCliAuth(stateDir: string, tokens?: { access?: string; refresh?: string }) {
    const codexHome = path.join(stateDir, "codex-home");
    process.env.CODEX_HOME = codexHome;
    await fs.mkdir(codexHome, { recursive: true });
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: tokens?.access ?? "file-access",
          refresh_token: tokens?.refresh ?? "file-refresh",
        },
      }),
      "utf8",
    );
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await lifecycle.cleanup();
  });

  it("writes env-backed OpenAI key as plaintext by default", async () => {
    const agentDir = await setupTempState();
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

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
    process.env.OPENAI_API_KEY = "sk-openai-env"; // pragma: allowlist secret

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

  it("skips follow-up model selection when OpenAI Codex OAuth throws", async () => {
    const loginSpy = vi
      .spyOn(openAICodexOAuth, "loginOpenAICodexOAuth")
      .mockRejectedValueOnce(new Error("oauth failed"));

    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).toMatchObject({
      config: {},
      skipDefaultModelPrompt: true,
    });
    expect(loginSpy).toHaveBeenCalled();
  });

  it("skips follow-up model selection when OpenAI Codex OAuth returns no credentials", async () => {
    const loginSpy = vi
      .spyOn(openAICodexOAuth, "loginOpenAICodexOAuth")
      .mockResolvedValueOnce(null);

    const prompter = createWizardPrompter({}, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).toMatchObject({
      config: {},
      skipDefaultModelPrompt: true,
    });
    expect(loginSpy).toHaveBeenCalled();
  });

  it("offers to sync Codex auth.json when OAuth succeeds but auth-profiles is missing", async () => {
    const env = await setupAuthTestEnv("openclaw-openai-");
    lifecycle.setStateDir(env.stateDir);
    await writeCodexCliAuth(env.stateDir);

    vi.spyOn(openAICodexOAuth, "loginOpenAICodexOAuth").mockResolvedValueOnce({
      provider: "openai-codex",
      access: "callback-access",
      refresh: "callback-refresh",
      expires: Date.now() + 60_000,
      email: "callback@example.com",
    });

    const confirm = vi.fn(async () => true);
    const prompter = createWizardPrompter({ confirm }, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      agentDir: env.agentDir,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: true,
        message: expect.stringContaining("Sync auth.json credentials into this agent now?"),
      }),
    );
    expect(result?.config.auth?.profiles?.["openai-codex:default"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { access?: string; refresh?: string }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
      access: "file-access",
      refresh: "file-refresh",
    });
  });

  it("uses callback credentials when auth.json sync is declined", async () => {
    const env = await setupAuthTestEnv("openclaw-openai-");
    lifecycle.setStateDir(env.stateDir);
    await writeCodexCliAuth(env.stateDir, {
      access: "file-access",
      refresh: "file-refresh",
    });

    vi.spyOn(openAICodexOAuth, "loginOpenAICodexOAuth").mockResolvedValueOnce({
      provider: "openai-codex",
      access: "callback-access",
      refresh: "callback-refresh",
      expires: Date.now() + 60_000,
      email: "callback@example.com",
    });

    const confirm = vi.fn(async () => false);
    const prompter = createWizardPrompter({ confirm }, { defaultSelect: "" });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceOpenAI({
      authChoice: "openai-codex",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      agentDir: env.agentDir,
    });

    expect(confirm).toHaveBeenCalledOnce();
    expect(result?.config.auth?.profiles?.["openai-codex:callback@example.com"]).toMatchObject({
      provider: "openai-codex",
      mode: "oauth",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<string, { access?: string; refresh?: string }>;
    }>(env.agentDir);
    expect(parsed.profiles?.["openai-codex:callback@example.com"]).toMatchObject({
      access: "callback-access",
      refresh: "callback-refresh",
    });
  });
});
