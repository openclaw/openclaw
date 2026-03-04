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

vi.mock("./anthropic-oauth.js", async () => {
  const { vi } = await import("vitest");
  return {
    loginAnthropicOAuth: vi.fn().mockResolvedValue({
      access: "sk-ant-test-access",
      refresh: "sk-ant-test-refresh",
      expires: Date.now() + 8 * 60 * 60 * 1000,
      email: "test@example.com",
    }),
  };
});

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

  it("stores OAuth credentials with refresh token and correct type", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAnthropic({
      authChoice: "oauth",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["anthropic:test@example.com"]).toMatchObject({
      provider: "anthropic",
      mode: "oauth",
    });

    const parsed = await readAuthProfilesForAgent<{
      profiles?: Record<
        string,
        { type?: string; access?: string; refresh?: string; expires?: number }
      >;
    }>(agentDir);
    const oauthProfile = parsed.profiles?.["anthropic:test@example.com"];
    expect(oauthProfile?.type).toBe("oauth");
    expect(oauthProfile?.access).toBe("sk-ant-test-access");
    expect(oauthProfile?.refresh).toBe("sk-ant-test-refresh");
    expect(oauthProfile?.expires).toBeGreaterThan(Date.now());
  });

  it("preserves auth.order when adding OAuth credentials", async () => {
    const agentDir = await setupTempState();
    const prompter = createWizardPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoiceAnthropic({
      authChoice: "oauth",
      config: {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
          },
          order: { anthropic: ["anthropic:default"] },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
      agentDir,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.order?.anthropic).toContain("anthropic:default");
  });
});
