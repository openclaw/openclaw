import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import { applyAuthChoiceLoadedPluginProvider } from "../../commands/auth-choice.apply.plugin-provider.js";
import type { AuthChoice } from "../../commands/onboard-types.js";
import {
  createAuthTestLifecycle,
  createExitThrowingRuntime,
  createWizardPrompter,
  readAuthProfilesForAgent,
  requireOpenClawAgentDir,
  setupAuthTestEnv,
} from "../../commands/test-wizard-helpers.js";
import { createCapturedPluginRegistration } from "../../test-utils/plugin-registration.js";
import type { OpenClawPluginApi, ProviderPlugin } from "../types.js";
import { providerContractRegistry } from "./registry.js";

type ResolvePluginProviders =
  typeof import("../../commands/auth-choice.apply.plugin-provider.runtime.js").resolvePluginProviders;
type ResolveProviderPluginChoice =
  typeof import("../../commands/auth-choice.apply.plugin-provider.runtime.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook =
  typeof import("../../commands/auth-choice.apply.plugin-provider.runtime.js").runProviderModelSelectedHook;

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

vi.mock("../../commands/auth-choice.apply.plugin-provider.runtime.js", () => ({
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
  await import("../../commands/auth-choice.preferred-provider.js");

type StoredAuthProfile = {
  type?: string;
  provider?: string;
  access?: string;
  refresh?: string;
  key?: string;
  token?: string;
};

const qwenPortalPlugin = (await import("../../../extensions/qwen-portal-auth/index.js")).default;

function registerProviders(...plugins: Array<{ register(api: OpenClawPluginApi): void }>) {
  const captured = createCapturedPluginRegistration();
  for (const plugin of plugins) {
    plugin.register(captured.api);
  }
  return captured.providers;
}

function requireProvider(providers: ProviderPlugin[], providerId: string) {
  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`provider ${providerId} missing`);
  }
  return provider;
}

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
    resolvePreferredProviderPluginProvidersMock.mockReturnValue([
      ...new Map(
        providerContractRegistry.map((entry) => [entry.provider.id, entry.provider]),
      ).values(),
    ]);
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

  it("maps plugin-backed auth choices through the shared preferred-provider resolver", async () => {
    const scenarios = [
      { authChoice: "github-copilot" as const, expectedProvider: "github-copilot" },
      { authChoice: "qwen-portal" as const, expectedProvider: "qwen-portal" },
      { authChoice: "minimax-global-oauth" as const, expectedProvider: "minimax-portal" },
      { authChoice: "modelstudio-api-key" as const, expectedProvider: "modelstudio" },
      { authChoice: "ollama" as const, expectedProvider: "ollama" },
      { authChoice: "unknown" as AuthChoice, expectedProvider: undefined },
    ] as const;

    for (const scenario of scenarios) {
      await expect(
        resolvePreferredProviderForAuthChoice({ choice: scenario.authChoice }),
      ).resolves.toBe(scenario.expectedProvider);
    }
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
