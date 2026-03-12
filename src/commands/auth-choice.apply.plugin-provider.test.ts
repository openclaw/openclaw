import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../plugins/types.js";
import type { ProviderAuthMethod } from "../plugins/types.js";
import type { ApplyAuthChoiceParams } from "./auth-choice.apply.js";
import { applyAuthChoiceLoadedPluginProvider } from "./auth-choice.apply.plugin-provider.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("../plugins/providers.js", () => ({
  resolvePluginProviders,
}));

const resolveProviderPluginChoice = vi.hoisted(() =>
  vi.fn<() => { provider: ProviderPlugin; method: ProviderAuthMethod } | null>(),
);
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice,
  runProviderModelSelectedHook,
}));

const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  upsertAuthProfile,
}));

const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "default"));
const resolveAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
const resolveAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
}));

const resolveDefaultAgentWorkspaceDir = vi.hoisted(() => vi.fn(() => "/tmp/workspace"));
vi.mock("../agents/workspace.js", () => ({
  resolveDefaultAgentWorkspaceDir,
}));

const resolveOpenClawAgentDir = vi.hoisted(() => vi.fn(() => "/tmp/agent"));
vi.mock("../agents/agent-paths.js", () => ({
  resolveOpenClawAgentDir,
}));

const applyAuthProfileConfig = vi.hoisted(() => vi.fn((config) => config));
vi.mock("./onboard-auth.js", () => ({
  applyAuthProfileConfig,
}));

const isRemoteEnvironment = vi.hoisted(() => vi.fn(() => false));
vi.mock("./oauth-env.js", () => ({
  isRemoteEnvironment,
}));

const createVpsAwareOAuthHandlers = vi.hoisted(() => vi.fn());
vi.mock("./oauth-flow.js", () => ({
  createVpsAwareOAuthHandlers,
}));

const openUrl = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./onboard-helpers.js", () => ({
  openUrl,
}));

function buildProvider(): ProviderPlugin {
  return {
    id: "ollama",
    label: "Ollama",
    auth: [
      {
        id: "local",
        label: "Ollama",
        kind: "custom",
        run: async () => ({
          profiles: [
            {
              profileId: "ollama:default",
              credential: {
                type: "api_key",
                provider: "ollama",
                key: "ollama-local",
              },
            },
          ],
          defaultModel: "ollama/qwen3:4b",
        }),
      },
    ],
  };
}

function buildParams(overrides: Partial<ApplyAuthChoiceParams> = {}): ApplyAuthChoiceParams {
  return {
    authChoice: "ollama",
    config: {},
    prompter: {
      note: vi.fn(async () => {}),
    } as unknown as ApplyAuthChoiceParams["prompter"],
    runtime: {} as ApplyAuthChoiceParams["runtime"],
    setDefaultModel: true,
    ...overrides,
  };
}

describe("applyAuthChoiceLoadedPluginProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies the default model and runs provider post-setup hooks", async () => {
    const provider = buildProvider();
    resolvePluginProviders.mockReturnValue([provider]);
    resolveProviderPluginChoice.mockReturnValue({
      provider,
      method: provider.auth[0],
    });

    const result = await applyAuthChoiceLoadedPluginProvider(buildParams());

    expect(result?.config.agents?.defaults?.model).toEqual({
      primary: "ollama/qwen3:4b",
    });
    expect(upsertAuthProfile).toHaveBeenCalledWith({
      profileId: "ollama:default",
      credential: {
        type: "api_key",
        provider: "ollama",
        key: "ollama-local",
      },
      agentDir: "/tmp/agent",
    });
    expect(runProviderModelSelectedHook).toHaveBeenCalledWith({
      config: result?.config,
      model: "ollama/qwen3:4b",
      prompter: expect.objectContaining({ note: expect.any(Function) }),
      agentDir: undefined,
      workspaceDir: "/tmp/workspace",
    });
  });
});
