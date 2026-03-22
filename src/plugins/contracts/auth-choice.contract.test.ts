import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "../../../test/helpers/auth-wizard.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import { resolvePreferredProviderForAuthChoice } from "../../plugins/provider-auth-choice-preference.js";
import { runProviderPluginAuthMethod } from "../../plugins/provider-auth-choice.js";
import { buildProviderPluginMethodChoice } from "../provider-wizard.js";
import { requireProviderContractProvider, uniqueProviderContractProviders } from "./registry.js";
import { registerProviders, requireProvider } from "./testkit.js";

type ResolvePluginProviders =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type ResolveProviderPluginChoice =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook =
  typeof import("../../plugins/provider-auth-choice.runtime.js").runProviderModelSelectedHook;
const loginQwenPortalOAuthMock = vi.hoisted(() => vi.fn());
const githubCopilotLoginCommandMock = vi.hoisted(() => vi.fn());
const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveProviderPluginChoiceMock = vi.hoisted(() => vi.fn<ResolveProviderPluginChoice>());
const runProviderModelSelectedHookMock = vi.hoisted(() =>
  vi.fn<RunProviderModelSelectedHook>(async () => {}),
);
import qwenPortalPlugin from "../../../extensions/qwen-portal-auth/index.js";

vi.mock("../../../extensions/qwen-portal-auth/oauth.js", () => ({
  loginQwenPortalOAuth: loginQwenPortalOAuthMock,
}));
vi.mock("../../providers/github-copilot-auth.js", () => ({
  githubCopilotLoginCommand: githubCopilotLoginCommandMock,
}));
vi.mock("../../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
  resolveProviderPluginChoice: resolveProviderPluginChoiceMock,
  runProviderModelSelectedHook: runProviderModelSelectedHookMock,
}));

type StoredAuthProfile = {
  type?: string;
  provider?: string;
  access?: string;
  refresh?: string;
  key?: string;
  token?: string;
};

describe("provider auth-choice contract", () => {
  const lifecycle = createAuthTestLifecycle([
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_AGENT_DIR",
    "PI_CODING_AGENT_DIR",
  ]);
  let activeStateDir: string | null = null;

  async function setupTempState() {
    if (activeStateDir) {
      await lifecycle.cleanup();
    }
    const env = await setupAuthTestEnv("openclaw-provider-auth-choice-");
    activeStateDir = env.stateDir;
    lifecycle.setStateDir(env.stateDir);
  }

  beforeEach(() => {
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue(uniqueProviderContractProviders);
    resolveProviderPluginChoiceMock.mockReset();
    resolveProviderPluginChoiceMock.mockImplementation(({ providers, choice }) => {
      const provider = providers.find((entry) =>
        entry.auth.some(
          (method) => buildProviderPluginMethodChoice(entry.id, method.id) === choice,
        ),
      );
      if (!provider) {
        return null;
      }
      const method =
        provider.auth.find(
          (entry) => buildProviderPluginMethodChoice(provider.id, entry.id) === choice,
        ) ?? null;
      return method ? { provider, method } : null;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    loginQwenPortalOAuthMock.mockReset();
    githubCopilotLoginCommandMock.mockReset();
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    resolveProviderPluginChoiceMock.mockReset();
    resolveProviderPluginChoiceMock.mockReturnValue(null);
    runProviderModelSelectedHookMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
    await lifecycle.cleanup();
    activeStateDir = null;
  });

  it("maps provider-plugin choices through the shared preferred-provider fallback resolver", async () => {
    const pluginFallbackScenarios = [
      "github-copilot",
      "qwen-portal",
      "minimax-portal",
      "modelstudio",
      "ollama",
    ].map((providerId) => {
      const provider = requireProviderContractProvider(providerId);
      return {
        authChoice: buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default"),
        expectedProvider: provider.id,
      };
    });

    for (const scenario of pluginFallbackScenarios) {
      resolvePluginProvidersMock.mockClear();
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice }),
      ).resolves.toBe(scenario.expectedProvider);
      expect(resolvePluginProvidersMock).toHaveBeenCalled();
    }
  }, 180_000);

  it("runs qwen portal auth through the shared plugin auth-method helper", async () => {
    await setupTempState();
    const qwenProvider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    loginQwenPortalOAuthMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      resourceUrl: "portal.qwen.ai",
    });

    const note = vi.fn(async () => {});
    const result = await runProviderPluginAuthMethod({
      config: {},
      prompter: createWizardPrompter({ note }),
      runtime: createExitThrowingRuntime(),
      method: qwenProvider.auth[0],
      allowSecretRefPrompt: false,
    });

    expect(result.config.auth?.profiles?.["qwen-portal:default"]).toMatchObject({
      provider: "qwen-portal",
      mode: "oauth",
    });
    expect(result.config.models?.providers?.["qwen-portal"]).toMatchObject({
      baseUrl: "https://portal.qwen.ai/v1",
      models: [],
    });
    expect(result.config.agents?.defaults?.models).toMatchObject({
      "qwen-portal/coder-model": { alias: "qwen" },
      "qwen-portal/vision-model": {},
    });
    expect(result.defaultModel).toBe("qwen-portal/coder-model");
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Qwen OAuth tokens auto-refresh."),
      "Provider notes",
    );

    const stored = await readAuthProfilesForAgent<{ profiles?: Record<string, StoredAuthProfile> }>(
      requireOpenClawAgentDir(),
    );
    expect(stored.profiles?.["qwen-portal:default"]).toMatchObject({
      type: "oauth",
      provider: "qwen-portal",
      access: "access-token",
      refresh: "refresh-token",
    });
  });

  it("returns qwen portal default-model overrides for deferred callers", async () => {
    await setupTempState();
    const qwenProvider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    loginQwenPortalOAuthMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      resourceUrl: "portal.qwen.ai",
    });

    const result = await runProviderPluginAuthMethod({
      config: {},
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      method: qwenProvider.auth[0],
      allowSecretRefPrompt: false,
    });

    expect(githubCopilotLoginCommandMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      config: {
        agents: {
          defaults: {
            models: {
              "qwen-portal/coder-model": {
                alias: "qwen",
              },
              "qwen-portal/vision-model": {},
            },
          },
        },
        auth: {
          profiles: {
            "qwen-portal:default": {
              provider: "qwen-portal",
              mode: "oauth",
            },
          },
        },
        models: {
          providers: {
            "qwen-portal": {
              baseUrl: "https://portal.qwen.ai/v1",
              models: [],
            },
          },
        },
      },
      defaultModel: "qwen-portal/coder-model",
    });

    const stored = await readAuthProfilesForAgent<{
      profiles?: Record<string, StoredAuthProfile>;
    }>(requireOpenClawAgentDir());
    expect(stored.profiles?.["qwen-portal:default"]).toMatchObject({
      type: "oauth",
      provider: "qwen-portal",
      access: "access-token",
      refresh: "refresh-token",
    });
  });
});
