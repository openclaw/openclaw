import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { AuthChoice } from "./onboard-types.js";
import { captureEnv } from "../test-utils/env.js";
import { applyAuthChoice, resolvePreferredProviderForAuthChoice } from "./auth-choice.js";
import {
  MINIMAX_CN_API_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
} from "./onboard-auth.js";
import {
  authProfilePathForAgent,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "./test-wizard-helpers.js";

vi.mock("../providers/github-copilot-auth.js", () => ({
  githubCopilotLoginCommand: vi.fn(async () => {}),
}));

const loginOpenAICodexOAuth = vi.hoisted(() => vi.fn(async () => null));
vi.mock("./openai-codex-oauth.js", () => ({
  loginOpenAICodexOAuth,
}));

const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

type StoredAuthProfile = {
  key?: string;
  access?: string;
  refresh?: string;
  provider?: string;
  type?: string;
  email?: string;
  metadata?: Record<string, string>;
};

describe("applyAuthChoice", () => {
  const envSnapshot = captureEnv([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "HF_TOKEN",
    "HUGGINGFACE_HUB_TOKEN",
    "LITELLM_API_KEY",
    "AI_GATEWAY_API_KEY",
    "CLOUDFLARE_AI_GATEWAY_API_KEY",
    "SSH_TTY",
    "CHUTES_CLIENT_ID",
  ]);
  let tempStateDir: string | null = null;
  async function setupTempState() {
    const env = await setupAuthTestEnv("openclaw-auth-");
    tempStateDir = env.stateDir;
  }
  function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
    return createWizardPrompter(overrides, { defaultSelect: "" });
  }
  async function readAuthProfiles() {
    return await readAuthProfilesForAgent<{
      profiles?: Record<string, StoredAuthProfile>;
    }>(requireOpenClawAgentDir());
  }
  async function readAuthProfile(profileId: string) {
    return (await readAuthProfiles()).profiles?.[profileId];
  }

  afterEach(async () => {
    vi.unstubAllGlobals();
    resolvePluginProviders.mockReset();
    loginOpenAICodexOAuth.mockReset();
    loginOpenAICodexOAuth.mockResolvedValue(null);
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    envSnapshot.restore();
  });

  it("does not throw when openai-codex oauth fails", async () => {
    await setupTempState();

    loginOpenAICodexOAuth.mockRejectedValueOnce(new Error("oauth failed"));

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    await expect(
      applyAuthChoice({
        authChoice: "openai-codex",
        config: {},
        prompter,
        runtime,
        setDefaultModel: false,
      }),
    ).resolves.toEqual({ config: {} });
  });

  it("prompts and writes MiniMax API key when selecting minimax-api", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-minimax-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "minimax-api",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax API key" }),
    );
    expect(result.config.auth?.profiles?.["minimax:default"]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });

    expect((await readAuthProfile("minimax:default"))?.key).toBe("sk-minimax-test");
  });

  it("prompts and writes MiniMax API key when selecting minimax-api-key-cn", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-minimax-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "minimax-api-key-cn",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax China API key" }),
    );
    expect(result.config.auth?.profiles?.["minimax-cn:default"]).toMatchObject({
      provider: "minimax-cn",
      mode: "api_key",
    });
    expect(result.config.models?.providers?.["minimax-cn"]?.baseUrl).toBe(MINIMAX_CN_API_BASE_URL);

    expect((await readAuthProfile("minimax-cn:default"))?.key).toBe("sk-minimax-test");
  });

  it("prompts and writes Synthetic API key when selecting synthetic-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-synthetic-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "synthetic-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter Synthetic API key" }),
    );
    expect(result.config.auth?.profiles?.["synthetic:default"]).toMatchObject({
      provider: "synthetic",
      mode: "api_key",
    });

    expect((await readAuthProfile("synthetic:default"))?.key).toBe("sk-synthetic-test");
  });

  it("prompts and writes Hugging Face API key when selecting huggingface-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("hf-test-token");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "huggingface-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Hugging Face") }),
    );
    expect(result.config.auth?.profiles?.["huggingface:default"]).toMatchObject({
      provider: "huggingface",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^huggingface\/.+/);

    expect((await readAuthProfile("huggingface:default"))?.key).toBe("hf-test-token");
  });

  it("prompts for Z.AI endpoint when selecting zai-api-key", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("zai-test-key");
    const select = vi.fn(async (params: { message: string }) => {
      if (params.message === "Select Z.AI endpoint") {
        return "coding-cn";
      }
      return "default";
    });
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({
      select: select as WizardPrompter["select"],
      multiselect,
      text,
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "zai-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select Z.AI endpoint", initialValue: "global" }),
    );
    expect(result.config.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
    expect(result.config.agents?.defaults?.model?.primary).toBe("zai/glm-5");

    expect((await readAuthProfile("zai:default"))?.key).toBe("zai-test-key");
  });

  it("uses endpoint-specific auth choice without prompting for Z.AI endpoint", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("zai-test-key");
    const select = vi.fn(async () => "default");
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({
      select: select as WizardPrompter["select"],
      multiselect,
      text,
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "zai-coding-global",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Select Z.AI endpoint" }),
    );
    expect(result.config.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_GLOBAL_BASE_URL);
  });

  it("maps apiKey + tokenProvider=huggingface to huggingface-api-key flow", async () => {
    await setupTempState();
    delete process.env.HF_TOKEN;
    delete process.env.HUGGINGFACE_HUB_TOKEN;

    const text = vi.fn().mockResolvedValue("should-not-be-used");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => false);
    const prompter = createPrompter({ select, multiselect, text, confirm });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
      opts: {
        tokenProvider: "huggingface",
        token: "hf-token-provider-test",
      },
    });

    expect(result.config.auth?.profiles?.["huggingface:default"]).toMatchObject({
      provider: "huggingface",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toMatch(/^huggingface\/.+/);
    expect(text).not.toHaveBeenCalled();

    expect((await readAuthProfile("huggingface:default"))?.key).toBe("hf-token-provider-test");
  });
  it("does not override the global default model when selecting xai-api-key without setDefaultModel", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-xai-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "xai-api-key",
      config: { agents: { defaults: { model: { primary: "openai/gpt-4o-mini" } } } },
      prompter,
      runtime,
      setDefaultModel: false,
      agentId: "agent-1",
    });

    expect(text).toHaveBeenCalledWith(expect.objectContaining({ message: "Enter xAI API key" }));
    expect(result.config.auth?.profiles?.["xai:default"]).toMatchObject({
      provider: "xai",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("openai/gpt-4o-mini");
    expect(result.agentModelOverride).toBe("xai/grok-4");

    expect((await readAuthProfile("xai:default"))?.key).toBe("sk-xai-test");
  });

  it("sets default model when selecting github-copilot", async () => {
    await setupTempState();

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const hadOwnIsTTY = Object.prototype.hasOwnProperty.call(stdin, "isTTY");
    const previousIsTTYDescriptor = Object.getOwnPropertyDescriptor(stdin, "isTTY");
    Object.defineProperty(stdin, "isTTY", {
      configurable: true,
      enumerable: true,
      get: () => true,
    });

    try {
      const result = await applyAuthChoice({
        authChoice: "github-copilot",
        config: {},
        prompter,
        runtime,
        setDefaultModel: true,
      });

      expect(result.config.agents?.defaults?.model?.primary).toBe("github-copilot/gpt-4o");
    } finally {
      if (previousIsTTYDescriptor) {
        Object.defineProperty(stdin, "isTTY", previousIsTTYDescriptor);
      } else if (!hadOwnIsTTY) {
        delete stdin.isTTY;
      }
    }
  });

  it("does not override the default model when selecting opencode-zen without setDefaultModel", async () => {
    await setupTempState();

    const text = vi.fn().mockResolvedValue("sk-opencode-zen-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "opencode-zen",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter OpenCode Zen API key" }),
    );
    expect(result.config.agents?.defaults?.model?.primary).toBe("anthropic/claude-opus-4-5");
    expect(result.config.models?.providers?.["opencode-zen"]).toBeUndefined();
    expect(result.agentModelOverride).toBe("opencode/claude-opus-4-6");
  });

  it("does not persist literal 'undefined' when Anthropic API key prompt returns undefined", async () => {
    await setupTempState();
    delete process.env.ANTHROPIC_API_KEY;

    const text = vi.fn(async () => undefined as unknown as string);
    const prompter = createPrompter({ text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "apiKey",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(result.config.auth?.profiles?.["anthropic:default"]).toMatchObject({
      provider: "anthropic",
      mode: "api_key",
    });

    expect((await readAuthProfile("anthropic:default"))?.key).toBe("");
    expect((await readAuthProfile("anthropic:default"))?.key).not.toBe("undefined");
  });

  it("does not persist literal 'undefined' when OpenRouter API key prompt returns undefined", async () => {
    await setupTempState();
    delete process.env.OPENROUTER_API_KEY;

    const text = vi.fn(async () => undefined as unknown as string);
    const prompter = createPrompter({ text });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openrouter-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(result.config.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });

    expect((await readAuthProfile("openrouter:default"))?.key).toBe("");
    expect((await readAuthProfile("openrouter:default"))?.key).not.toBe("undefined");
  });

  it("uses existing OPENROUTER_API_KEY when selecting openrouter-api-key", async () => {
    await setupTempState();
    process.env.OPENROUTER_API_KEY = "sk-openrouter-test";

    const text = vi.fn();
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => true);
    const prompter = createPrompter({ select, multiselect, text, confirm });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "openrouter-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENROUTER_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("openrouter/auto");

    expect((await readAuthProfile("openrouter:default"))?.key).toBe("sk-openrouter-test");

    delete process.env.OPENROUTER_API_KEY;
  });

  it("ignores legacy LiteLLM oauth profiles when selecting litellm-api-key", async () => {
    await setupTempState();
    process.env.LITELLM_API_KEY = "sk-litellm-test";

    const authProfilePath = authProfilePathForAgent(requireOpenClawAgentDir());
    await fs.writeFile(
      authProfilePath,
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "litellm:legacy": {
              type: "oauth",
              provider: "litellm",
              access: "access-token",
              refresh: "refresh-token",
              expires: Date.now() + 60_000,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const text = vi.fn();
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => true);
    const prompter = createPrompter({ select, multiselect, text, confirm });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "litellm-api-key",
      config: {
        auth: {
          profiles: {
            "litellm:legacy": { provider: "litellm", mode: "oauth" },
          },
          order: { litellm: ["litellm:legacy"] },
        },
      },
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("LITELLM_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["litellm:default"]).toMatchObject({
      provider: "litellm",
      mode: "api_key",
    });

    expect(await readAuthProfile("litellm:default")).toMatchObject({
      type: "api_key",
      key: "sk-litellm-test",
    });
  });

  it("uses existing AI_GATEWAY_API_KEY when selecting ai-gateway-api-key", async () => {
    await setupTempState();
    process.env.AI_GATEWAY_API_KEY = "gateway-test-key";

    const text = vi.fn();
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => true);
    const prompter = createPrompter({ select, multiselect, text, confirm });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "ai-gateway-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("AI_GATEWAY_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["vercel-ai-gateway:default"]).toMatchObject({
      provider: "vercel-ai-gateway",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "vercel-ai-gateway/anthropic/claude-opus-4.6",
    );

    expect((await readAuthProfile("vercel-ai-gateway:default"))?.key).toBe("gateway-test-key");

    delete process.env.AI_GATEWAY_API_KEY;
  });

  it("uses existing CLOUDFLARE_AI_GATEWAY_API_KEY when selecting cloudflare-ai-gateway-api-key", async () => {
    await setupTempState();
    process.env.CLOUDFLARE_AI_GATEWAY_API_KEY = "cf-gateway-test-key";

    const text = vi
      .fn()
      .mockResolvedValueOnce("cf-account-id")
      .mockResolvedValueOnce("cf-gateway-id");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => true);
    const prompter = createPrompter({ select, multiselect, text, confirm });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "cloudflare-ai-gateway-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("CLOUDFLARE_AI_GATEWAY_API_KEY"),
      }),
    );
    expect(text).toHaveBeenCalledTimes(2);
    expect(result.config.auth?.profiles?.["cloudflare-ai-gateway:default"]).toMatchObject({
      provider: "cloudflare-ai-gateway",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "cloudflare-ai-gateway/claude-sonnet-4-5",
    );

    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.key).toBe(
      "cf-gateway-test-key",
    );
    expect((await readAuthProfile("cloudflare-ai-gateway:default"))?.metadata).toEqual({
      accountId: "cf-account-id",
      gatewayId: "cf-gateway-id",
    });

    delete process.env.CLOUDFLARE_AI_GATEWAY_API_KEY;
  });

  it("writes Chutes OAuth credentials when selecting chutes (remote/manual)", async () => {
    await setupTempState();
    process.env.SSH_TTY = "1";
    process.env.CHUTES_CLIENT_ID = "cid_test";

    const fetchSpy = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://api.chutes.ai/idp/token") {
        return new Response(
          JSON.stringify({
            access_token: "at_test",
            refresh_token: "rt_test",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.chutes.ai/idp/userinfo") {
        return new Response(JSON.stringify({ username: "remote-user" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const runtime = createExitThrowingRuntime();
    const text: WizardPrompter["text"] = vi.fn(async (params) => {
      if (params.message === "Paste the redirect URL") {
        const lastLog = runtime.log.mock.calls.at(-1)?.[0];
        const urlLine = typeof lastLog === "string" ? lastLog : String(lastLog ?? "");
        const urlMatch = urlLine.match(/https?:\/\/\S+/)?.[0] ?? "";
        const state = urlMatch ? new URL(urlMatch).searchParams.get("state") : null;
        if (!state) {
          throw new Error("missing state in oauth URL");
        }
        return `?code=code_manual&state=${state}`;
      }
      return "code_manual";
    });
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter = createPrompter({ select, multiselect, text });

    const result = await applyAuthChoice({
      authChoice: "chutes",
      config: {},
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Paste the redirect URL",
      }),
    );
    expect(result.config.auth?.profiles?.["chutes:remote-user"]).toMatchObject({
      provider: "chutes",
      mode: "oauth",
    });

    expect(await readAuthProfile("chutes:remote-user")).toMatchObject({
      provider: "chutes",
      access: "at_test",
      refresh: "rt_test",
      email: "remote-user",
    });
  });

  it("writes Qwen credentials when selecting qwen-portal", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "qwen-portal",
        label: "Qwen",
        auth: [
          {
            id: "device",
            label: "Qwen OAuth",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "qwen-portal:default",
                  credential: {
                    type: "oauth",
                    provider: "qwen-portal",
                    access: "access",
                    refresh: "refresh",
                    expires: Date.now() + 60 * 60 * 1000,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "qwen-portal": {
                      baseUrl: "https://portal.qwen.ai/v1",
                      apiKey: "qwen-oauth",
                      api: "openai-completions",
                      models: [],
                    },
                  },
                },
              },
              defaultModel: "qwen-portal/coder-model",
            })),
          },
        ],
      },
    ]);

    const prompter = createPrompter({});
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "qwen-portal",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["qwen-portal:default"]).toMatchObject({
      provider: "qwen-portal",
      mode: "oauth",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("qwen-portal/coder-model");
    expect(result.config.models?.providers?.["qwen-portal"]).toMatchObject({
      baseUrl: "https://portal.qwen.ai/v1",
      apiKey: "qwen-oauth",
    });

    expect(await readAuthProfile("qwen-portal:default")).toMatchObject({
      provider: "qwen-portal",
      access: "access",
      refresh: "refresh",
    });
  });

  it("writes MiniMax credentials when selecting minimax-portal", async () => {
    await setupTempState();

    resolvePluginProviders.mockReturnValue([
      {
        id: "minimax-portal",
        label: "MiniMax",
        auth: [
          {
            id: "oauth",
            label: "MiniMax OAuth (Global)",
            kind: "device_code",
            run: vi.fn(async () => ({
              profiles: [
                {
                  profileId: "minimax-portal:default",
                  credential: {
                    type: "oauth",
                    provider: "minimax-portal",
                    access: "access",
                    refresh: "refresh",
                    expires: Date.now() + 60 * 60 * 1000,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    "minimax-portal": {
                      baseUrl: "https://api.minimax.io/anthropic",
                      apiKey: "minimax-oauth",
                      api: "anthropic-messages",
                      models: [],
                    },
                  },
                },
              },
              defaultModel: "minimax-portal/MiniMax-M2.1",
            })),
          },
        ],
      },
    ]);

    const prompter = createPrompter({
      select: vi.fn(async () => "oauth" as never) as WizardPrompter["select"],
    });
    const runtime = createExitThrowingRuntime();

    const result = await applyAuthChoice({
      authChoice: "minimax-portal",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(result.config.auth?.profiles?.["minimax-portal:default"]).toMatchObject({
      provider: "minimax-portal",
      mode: "oauth",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe("minimax-portal/MiniMax-M2.1");
    expect(result.config.models?.providers?.["minimax-portal"]).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      apiKey: "minimax-oauth",
    });

    expect(await readAuthProfile("minimax-portal:default")).toMatchObject({
      provider: "minimax-portal",
      access: "access",
      refresh: "refresh",
    });
  });
});

describe("resolvePreferredProviderForAuthChoice", () => {
  it("maps github-copilot to the provider", () => {
    expect(resolvePreferredProviderForAuthChoice("github-copilot")).toBe("github-copilot");
  });

  it("maps qwen-portal to the provider", () => {
    expect(resolvePreferredProviderForAuthChoice("qwen-portal")).toBe("qwen-portal");
  });

  it("returns undefined for unknown choices", () => {
    expect(resolvePreferredProviderForAuthChoice("unknown" as AuthChoice)).toBeUndefined();
  });
});
