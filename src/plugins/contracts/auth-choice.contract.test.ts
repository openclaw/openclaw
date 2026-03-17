import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import type { AuthChoice } from "../../commands/onboard-types.js";
import { applyAuthChoiceLoadedPluginProvider } from "../../plugins/provider-auth-choice.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "../../commands/test-wizard-helpers.js";
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
const resolvePreferredProviderPluginProvidersMock = vi.hoisted(() => vi.fn());

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

vi.mock("../../plugins/providers.js", async () => {
  const actual = await vi.importActual<object>("../../plugins/providers.js");
  return {
    ...actual,
    resolvePluginProviders: (...args: unknown[]) =>
      resolvePreferredProviderPluginProvidersMock(...args),
  };
});

const { resolvePreferredProviderForAuthChoice } =
  await import("../../plugins/provider-auth-choice-preference.js");

type StoredAuthProfile = {
  type?: string;
  provider?: string;
  access?: string;
  refresh?: string;
  key?: string;
  token?: string;
};

const qwenPortalPlugin = (await import("../../../extensions/qwen-portal-auth/index.js")).default;

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
    resolvePreferredProviderPluginProvidersMock.mockReset();
    resolvePreferredProviderPluginProvidersMock.mockReturnValue(uniqueProviderContractProviders);
  });

  afterEach(async () => {
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
      resolvePreferredProviderPluginProvidersMock.mockClear();
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice as AuthChoice }),
      ).resolves.toBe(scenario.expectedProvider);
      expect(resolvePreferredProviderPluginProvidersMock).toHaveBeenCalled();
    }

    resolvePreferredProviderPluginProvidersMock.mockClear();
    await expect(
      resolvePreferredProviderForAuthChoice({ choice: "unknown" as AuthChoice }),
    ).resolves.toBe(undefined);
    expect(resolvePreferredProviderPluginProvidersMock).toHaveBeenCalled();
  });

  it("applies qwen portal auth choices through the shared plugin-provider path", async () => {
    await setupTempState();
    const qwenProvider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    resolvePluginProvidersMock.mockReturnValue([qwenProvider]);
    resolveProviderPluginChoiceMock.mockReturnValue({
      provider: qwenProvider,
      method: qwenProvider.auth[0],
    });
    loginQwenPortalOAuthMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      resourceUrl: "portal.qwen.ai",
    });

    const note = vi.fn(async () => {});
    const result = await applyAuthChoiceLoadedPluginProvider({
      authChoice: "qwen-portal",
      config: {},
      prompter: createWizardPrompter({ note }),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: true,
    });

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "qwen-portal/coder-model",
    });
    expect(result?.config.auth?.profiles?.["qwen-portal:default"]).toMatchObject({
      provider: "qwen-portal",
      mode: "oauth",
    });
    expect(result?.config.models?.providers?.["qwen-portal"]).toMatchObject({
      baseUrl: "https://portal.qwen.ai/v1",
      models: [],
    });
    expect(note).toHaveBeenCalledWith(
      "Default model set to qwen-portal/coder-model",
      "Model configured",
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

  it("returns provider agent overrides when default-model application is deferred", async () => {
    await setupTempState();
    const qwenProvider = requireProvider(registerProviders(qwenPortalPlugin), "qwen-portal");
    resolvePluginProvidersMock.mockReturnValue([qwenProvider]);
    resolveProviderPluginChoiceMock.mockReturnValue({
      provider: qwenProvider,
      method: qwenProvider.auth[0],
    });
    loginQwenPortalOAuthMock.mockResolvedValueOnce({
      access: "access-token",
      refresh: "refresh-token",
      expires: 1_700_000_000_000,
      resourceUrl: "portal.qwen.ai",
    });

    const result = await applyAuthChoiceLoadedPluginProvider({
      authChoice: "qwen-portal",
      config: {},
      prompter: createWizardPrompter({}),
      runtime: createExitThrowingRuntime(),
      setDefaultModel: false,
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
      agentModelOverride: "qwen-portal/coder-model",
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
