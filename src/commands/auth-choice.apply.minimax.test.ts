import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { applyAuthChoiceMiniMax } from "./auth-choice.apply.minimax.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

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

  async function runMiniMaxChoice(params: {
    authChoice: Parameters<typeof applyAuthChoiceMiniMax>[0]["authChoice"];
    opts?: Parameters<typeof applyAuthChoiceMiniMax>[0]["opts"];
    env?: { apiKey?: string };
    prompterText?: () => Promise<string>;
  }) {
    const agentDir = await setupTempState();
    resetMiniMaxEnv();
    if (params.env?.apiKey !== undefined) {
      process.env.MINIMAX_API_KEY = params.env.apiKey;
    }

    const text = vi.fn(async () => "should-not-be-used");
    const confirm = vi.fn(async () => true);
    const result = await applyAuthChoiceMiniMax({
      authChoice: params.authChoice,
      config: {},
      // Pass select: undefined so ref-mode uses the non-interactive fallback (same as old test behavior).
      prompter: createWizardPrompter({
        text: params.prompterText ?? text,
        confirm,
        select: undefined,
      }),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
      ...(params.opts ? { opts: params.opts } : {}),
    });

    return { agentDir, result, text, confirm };
  }

  afterEach(async () => {
    await lifecycle.cleanup();
  });

  it("returns null for unrelated authChoice", async () => {
    const result = await applyAuthChoiceMiniMax({
      authChoice: "openrouter-api-key",
      config: {},
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result).toBeNull();
  });

  it.each([
    {
      caseName: "uses opts token for minimax-global-api without prompt",
      authChoice: "minimax-global-api" as const,
      tokenProvider: "minimax",
      token: "mm-opts-token",
      profileId: "minimax:global",
      expectedModel: "minimax/MiniMax-M2.5",
    },
    {
      caseName: "uses opts token for minimax-cn-api with trimmed/case-insensitive tokenProvider",
      authChoice: "minimax-cn-api" as const,
      tokenProvider: "  MINIMAX  ",
      token: "mm-cn-opts-token",
      profileId: "minimax:cn",
      expectedModel: "minimax/MiniMax-M2.5",
    },
  ])("$caseName", async ({ authChoice, tokenProvider, token, profileId, expectedModel }) => {
    const { agentDir, result, text, confirm } = await runMiniMaxChoice({
      authChoice,
      opts: { tokenProvider, token },
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.[profileId]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
      expectedModel,
    );
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.[profileId]?.key).toBe(token);
  });

  it.each([
    {
      name: "uses env token for minimax-cn-api as plaintext by default",
      opts: undefined,
      expectKey: "mm-env-token",
      expectKeyRef: undefined,
      expectConfirmCalls: 1,
    },
    {
      name: "uses env token for minimax-cn-api as keyRef in ref mode",
      opts: { secretInputMode: "ref" as const }, // pragma: allowlist secret
      expectKey: undefined,
      expectKeyRef: {
        source: "env",
        provider: "default",
        id: "MINIMAX_API_KEY",
      },
      expectConfirmCalls: 0,
    },
  ])("$name", async ({ opts, expectKey, expectKeyRef, expectConfirmCalls }) => {
    const { agentDir, result, text, confirm } = await runMiniMaxChoice({
      authChoice: "minimax-cn-api",
      opts,
      env: { apiKey: "mm-env-token" }, // pragma: allowlist secret
    });

    expect(result).not.toBeNull();
    if (!opts) {
      expect(result?.config.auth?.profiles?.["minimax:cn"]).toMatchObject({
        provider: "minimax",
        mode: "api_key",
      });
      expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
        "minimax/MiniMax-M2.5",
      );
    }
    expect(text).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledTimes(expectConfirmCalls);

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["minimax:cn"]?.key).toBe(expectKey);
    if (expectKeyRef) {
      expect(parsed.profiles?.["minimax:cn"]?.keyRef).toEqual(expectKeyRef);
    } else {
      expect(parsed.profiles?.["minimax:cn"]?.keyRef).toBeUndefined();
    }
  });

  it("minimax-global-api uses minimax:global profile and minimax/MiniMax-M2.5 model", async () => {
    const { agentDir, result, text, confirm } = await runMiniMaxChoice({
      authChoice: "minimax-global-api",
      opts: {
        tokenProvider: "minimax",
        token: "mm-global-token",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.config.auth?.profiles?.["minimax:global"]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });
    expect(resolveAgentModelPrimaryValue(result?.config.agents?.defaults?.model)).toBe(
      "minimax/MiniMax-M2.5",
    );
    expect(result?.config.models?.providers?.minimax?.baseUrl).toContain("minimax.io");
    expect(text).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();

    const parsed = await readAuthProfiles(agentDir);
    expect(parsed.profiles?.["minimax:global"]?.key).toBe("mm-global-token");
  });

  it("minimax-cn-api sets CN baseUrl", async () => {
    const { result } = await runMiniMaxChoice({
      authChoice: "minimax-cn-api",
      opts: {
        tokenProvider: "minimax",
        token: "mm-cn-token",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.config.models?.providers?.minimax?.baseUrl).toContain("minimaxi.com");
  });
});
