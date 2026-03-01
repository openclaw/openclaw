import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoiceMiniMax } from "./auth-choice.apply.minimax.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

function createMinimaxPrompter(
  params: {
    text?: WizardPrompter["text"];
    confirm?: WizardPrompter["confirm"];
    select?: WizardPrompter["select"];
  } = {},
): WizardPrompter {
  return createWizardPrompter(
    {
      text: params.text,
      confirm: params.confirm,
      select: params.select,
    },
    { defaultSelect: "oauth" },
  );
}

describe("applyAuthChoiceMiniMax", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "MINIMAX_API_KEY",
    "MINIMAX_OAUTH_TOKEN",
  ]);

  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-minimax-");
    lifecycle.setStateDir(env.stateDir);
    return env.agentDir;
  }

  async function readAuthProfiles(agentDir: string) {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, { key?: string; keyRef?: { source: string; id: string } }>;
    }>(agentDir);
  }

  function resetMiniMaxEnv(): void {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_OAUTH_TOKEN;
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("returns null for unrelated authChoice", async () => {
    const result = await applyAuthChoiceMiniMax({
      authChoice: "openrouter-api-key",
      config: {},
      prompter: createMinimaxPrompter(),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result).toBeNull();
  });

  it.each([
    {
      caseName: "uses opts token for minimax-api without prompt",
      authChoice: "minimax-api" as const,
      tokenProvider: "minimax",
      token: "mm-opts-token",
      profileId: "minimax:default",
      provider: "minimax",
      expectedModel: "minimax/MiniMax-M2.5",
    },
    {
      caseName:
        "uses opts token for minimax-api-key-cn with trimmed/case-insensitive tokenProvider",
      authChoice: "minimax-api-key-cn" as const,
      tokenProvider: "  MINIMAX-CN  ",
      token: "mm-cn-opts-token",
      profileId: "minimax-cn:default",
      provider: "minimax-cn",
      expectedModel: "minimax-cn/MiniMax-M2.5",
    },
  ])(
    "$caseName",
    async ({ authChoice, tokenProvider, token, profileId, provider, expectedModel }) => {
      const agentDir = await setupTempState();
      resetMiniMaxEnv();

      const text = vi.fn(async () => "should-not-be-used");
      const confirm = vi.fn(async () => true);

      const result = await applyAuthChoiceMiniMax({
        authChoice,
        config: {},
        prompter: createMinimaxPrompter({ text, confirm }),
        runtime: createExitThrowingRuntime(),
        setDefaultModel: true,
        opts: {
          tokenProvider,
          token,
        },
      });

      expect(result).not.toBeNull();
      expect(result?.config.auth?.profiles?.[profileId]).toMatchObject({
        provider,
        mode: "api_key",
      });
      expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
        expectedModel,
      );
      expect(text).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();

      const parsed = await readAuthProfiles(agentDir);
      expect(parsed.profiles?.[profileId]?.key).toBe(token);
    },
  );

  it("uses env token for minimax-api-key-cn as plaintext by default", async () => {
    const agentDir = await setupTempState();
    process.env.MINIMAX_API_KEY = "mm-env-token";
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const text = vi.fn(async () => "should-not-be-used");
    const confirm = vi.fn(async () => true);

    const result = await applyAuthChoiceMiniMax({
      authChoice: "minimax-api-key-cn",
      config: {},
      prompter: createMinimaxPrompter({ text, confirm }),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["minimax-cn:default"]).toMatchObject({
      provider: "minimax-cn",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
      "minimax-cn/MiniMax-M2.5",
    );
    expect(text).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["minimax-cn:default"]?.key).toBe("mm-env-token");
    expect(parsed.profiles?.["minimax-cn:default"]?.keyRef).toBeUndefined();
  });

  it("uses env token for minimax-api-key-cn as keyRef in ref mode", async () => {
    const agentDir = await setupTempState();
    process.env.MINIMAX_API_KEY = "mm-env-token";
    delete process.env.MINIMAX_OAUTH_TOKEN;

    const text = vi.fn(async () => "should-not-be-used");
    const confirm = vi.fn(async () => true);

    const result = await applyAuthChoiceMiniMax({
      authChoice: "minimax-api-key-cn",
      config: {},
      prompter: createMinimaxPrompter({ text, confirm }),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
      opts: {
        secretInputMode: "ref",
      },
    });

    expect(result).not.toBeNull();
    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["minimax-cn:default"]?.keyRef).toEqual({
      source: "env",
      provider: "default",
      id: "MINIMAX_API_KEY",
    });
    expect(parsed.profiles?.["minimax-cn:default"]?.key).toBeUndefined();
  });

  it("uses minimax-api-lightning default model", async () => {
    const agentDir = await setupTempState();
    resetMiniMaxEnv();

    const text = vi.fn(async () => "should-not-be-used");
    const confirm = vi.fn(async () => true);

    const result = await applyAuthChoiceMiniMax({
      authChoice: "minimax-api-lightning",
      config: {},
      prompter: createMinimaxPrompter({ text, confirm }),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
      opts: {
        tokenProvider: "minimax",
        token: "mm-lightning-token",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["minimax:default"]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
      "minimax/MiniMax-M2.5-Lightning",
    );
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["minimax:default"]?.key).toBe("mm-lightning-token");
  });
});
