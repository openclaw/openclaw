import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
  runProviderModelSelectedHook,
} from "./provider-wizard.js";
import type { ProviderPlugin } from "./types.js";

const resolvePluginProviders = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  resolvePluginProviders,
}));

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("uses explicit setup choice ids and bound method ids", () => {
    const provider = makeProvider({
      id: "vllm",
      label: "vLLM",
      auth: [
        { id: "local", label: "Local", kind: "custom", run: vi.fn() },
        { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
      ],
      wizard: {
        setup: {
          choiceId: "self-hosted-vllm",
          methodId: "local",
          choiceLabel: "vLLM local",
          groupId: "local-runtimes",
          groupLabel: "Local runtimes",
        },
      },
    });
    resolvePluginProviders.mockReturnValue([provider]);

    expect(resolveProviderWizardOptions({})).toEqual([
      {
        value: "self-hosted-vllm",
        label: "vLLM local",
        groupId: "local-runtimes",
        groupLabel: "Local runtimes",
      },
    ]);
    expect(
      resolveProviderPluginChoice({
        providers: [provider],
        choice: "self-hosted-vllm",
      }),
    ).toEqual({
      provider,
      method: provider.auth[0],
      wizard: provider.wizard?.setup,
    });
  });

  it("builds wizard options from method-level metadata", () => {
    const provider = makeProvider({
      id: "openai",
      label: "OpenAI",
      auth: [
        {
          id: "api-key",
          label: "OpenAI API key",
          kind: "api_key",
          wizard: {
            choiceId: "openai-api-key",
            choiceLabel: "OpenAI API key",
            groupId: "openai",
            groupLabel: "OpenAI",
            onboardingScopes: ["text-inference"],
          },
          run: vi.fn(),
        },
      ],
    });
    resolvePluginProviders.mockReturnValue([provider]);

    expect(resolveProviderWizardOptions({})).toEqual([
      {
        value: "openai-api-key",
        label: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        onboardingScopes: ["text-inference"],
      },
    ]);
    expect(
      resolveProviderPluginChoice({
        providers: [provider],
        choice: "openai-api-key",
      }),
    ).toEqual({
      provider,
      method: provider.auth[0],
      wizard: provider.auth[0]?.wizard,
    });
  });

  it("preserves onboarding scopes on wizard options", () => {
    const provider = makeProvider({
      id: "fal",
      label: "fal",
      auth: [
        {
          id: "api-key",
          label: "fal API key",
          kind: "api_key",
          wizard: {
            choiceId: "fal-api-key",
            choiceLabel: "fal API key",
            groupId: "fal",
            groupLabel: "fal",
            onboardingScopes: ["image-generation"],
          },
          run: vi.fn(),
        },
      ],
    });
    resolvePluginProviders.mockReturnValue([provider]);

    expect(resolveProviderWizardOptions({})).toEqual([
      {
        value: "fal-api-key",
        label: "fal API key",
        groupId: "fal",
        groupLabel: "fal",
        onboardingScopes: ["image-generation"],
      },
    ]);
  });

  it("returns method wizard metadata for canonical choices", () => {
    const provider = makeProvider({
      id: "anthropic",
      label: "Anthropic",
      auth: [
        {
          id: "setup-token",
          label: "setup-token",
          kind: "token",
          wizard: {
            choiceId: "token",
            modelAllowlist: {
              allowedKeys: ["anthropic/claude-sonnet-4-6"],
              initialSelections: ["anthropic/claude-sonnet-4-6"],
              message: "Anthropic OAuth models",
            },
          },
          run: vi.fn(),
        },
      ],
    });

    expect(
      resolveProviderPluginChoice({
        providers: [provider],
        choice: "token",
      }),
    ).toEqual({
      provider,
      method: provider.auth[0],
      wizard: provider.auth[0]?.wizard,
    });
  });

  it("builds model-picker entries from plugin metadata and provider-method choices", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [
        { id: "server", label: "Server", kind: "custom", run: vi.fn() },
        { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
      ],
      wizard: {
        modelPicker: {
          label: "SGLang server",
          hint: "OpenAI-compatible local runtime",
          methodId: "server",
        },
      },
    });
    resolvePluginProviders.mockReturnValue([provider]);

    expect(resolveProviderModelPickerEntries({})).toEqual([
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
  });

  it("reuses provider resolution across wizard consumers for the same config and env", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
        modelPicker: {
          label: "SGLang server",
          methodId: "server",
        },
      },
    });
    const config = {};
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    expect(
      resolveProviderWizardOptions({
        config,
        workspaceDir: "/tmp/workspace",
        env,
      }),
    ).toHaveLength(1);
    expect(
      resolveProviderModelPickerEntries({
        config,
        workspaceDir: "/tmp/workspace",
        env,
      }),
    ).toHaveLength(1);

    expect(resolvePluginProviders).toHaveBeenCalledTimes(1);
    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
  });

  it("invalidates the wizard cache when config or env contents change in place", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
      },
    });
    const config = {
      plugins: {
        allow: ["sglang"],
      },
    };
    const env = { OPENCLAW_HOME: "/tmp/openclaw-home-a" } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    expect(
      resolveProviderWizardOptions({
        config,
        workspaceDir: "/tmp/workspace",
        env,
      }),
    ).toHaveLength(1);

    config.plugins.allow = ["vllm"];
    env.OPENCLAW_HOME = "/tmp/openclaw-home-b";

    expect(
      resolveProviderWizardOptions({
        config,
        workspaceDir: "/tmp/workspace",
        env,
      }),
    ).toHaveLength(1);

    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
  });

  it("skips provider-wizard memoization when plugin cache opt-outs are set", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
      },
    });
    const config = {
      plugins: {
        allow: ["sglang"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
  });

  it("skips provider-wizard memoization when discovery cache ttl is zero", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
      },
    });
    const config = {
      plugins: {
        allow: ["sglang"],
      },
    };
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
    } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
  });

  it("expires provider-wizard memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
      },
    });
    const config = {};
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
    vi.advanceTimersByTime(4);
    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });
    vi.advanceTimersByTime(2);
    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
  });

  it("invalidates provider-wizard snapshots when cache-control env values change in place", () => {
    const provider = makeProvider({
      id: "sglang",
      label: "SGLang",
      auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
      wizard: {
        setup: {
          choiceLabel: "SGLang setup",
          groupId: "sglang",
          groupLabel: "SGLang",
        },
      },
    });
    const config = {};
    const env = {
      OPENCLAW_HOME: "/tmp/openclaw-home",
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    } as NodeJS.ProcessEnv;
    resolvePluginProviders.mockReturnValue([provider]);

    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";

    resolveProviderWizardOptions({
      config,
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledTimes(2);
  });

  it("routes model-selected hooks only to the matching provider", async () => {
    const matchingHook = vi.fn(async () => {});
    const otherHook = vi.fn(async () => {});
    resolvePluginProviders.mockReturnValue([
      makeProvider({
        id: "ollama",
        label: "Ollama",
        onModelSelected: otherHook,
      }),
      makeProvider({
        id: "vllm",
        label: "vLLM",
        onModelSelected: matchingHook,
      }),
    ]);

    const env = { OPENCLAW_HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;
    await runProviderModelSelectedHook({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/tmp/workspace",
      env,
    });
    expect(matchingHook).toHaveBeenCalledWith({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {},
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
    });
    expect(otherHook).not.toHaveBeenCalled();
  });
});
