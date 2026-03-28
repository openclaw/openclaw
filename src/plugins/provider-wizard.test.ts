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

const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

function createSglangSetupProvider() {
  return makeProvider({
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
}

function createSglangWizardProvider(params?: {
  includeSetup?: boolean;
  includeModelPicker?: boolean;
}) {
  return makeProvider({
    id: "sglang",
    label: "SGLang",
    auth: [{ id: "server", label: "Server", kind: "custom", run: vi.fn() }],
    wizard: {
      ...((params?.includeSetup ?? true)
        ? {
            setup: {
              choiceLabel: "SGLang setup",
              groupId: "sglang",
              groupLabel: "SGLang",
            },
          }
        : {}),
      ...(params?.includeModelPicker
        ? {
            modelPicker: {
              label: "SGLang server",
              methodId: "server",
            },
          }
        : {}),
    },
  });
}

function createSglangConfig() {
  return {
    plugins: {
      allow: ["sglang"],
    },
  };
}

function createHomeEnv(suffix = "", overrides?: Partial<NodeJS.ProcessEnv>) {
  return {
    OPENCLAW_HOME: `/tmp/openclaw-home${suffix}`,
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function createWizardRuntimeParams(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
}) {
  return {
    config: params?.config ?? createSglangConfig(),
    workspaceDir: params?.workspaceDir ?? DEFAULT_WORKSPACE_DIR,
    env: params?.env ?? createHomeEnv(),
  };
}

function expectProviderResolutionCall(params?: {
  config?: object;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  count?: number;
}) {
  expect(resolvePluginProviders).toHaveBeenCalledTimes(params?.count ?? 1);
  expect(resolvePluginProviders).toHaveBeenCalledWith({
    ...createWizardRuntimeParams(params),
    bundledProviderAllowlistCompat: true,
    bundledProviderVitestCompat: true,
  });
}

function setResolvedProviders(...providers: ProviderPlugin[]) {
  resolvePluginProviders.mockReturnValue(providers);
}

function resolveWizardOptionsTwice(params: {
  config?: object;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}) {
  const runtimeParams = createWizardRuntimeParams(params);
  resolveProviderWizardOptions(runtimeParams);
  resolveProviderWizardOptions(runtimeParams);
}

function expectWizardProviderCacheMiss(params: { config?: object; env: NodeJS.ProcessEnv }) {
  resolveWizardOptionsTwice(params);
  expectProviderResolutionCall({ ...params, count: 2 });
}

function expectSingleWizardChoice(params: {
  provider: ProviderPlugin;
  choice: string;
  expectedOption: Record<string, unknown>;
  expectedWizard: unknown;
}) {
  setResolvedProviders(params.provider);
  expect(resolveProviderWizardOptions({})).toEqual([params.expectedOption]);
  expect(
    resolveProviderPluginChoice({
      providers: [params.provider],
      choice: params.choice,
    }),
  ).toEqual({
    provider: params.provider,
    method: params.provider.auth[0],
    wizard: params.expectedWizard,
  });
}

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([
    {
      name: "uses explicit setup choice ids and bound method ids",
      provider: makeProvider({
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
      }),
      choice: "self-hosted-vllm",
      expectedOption: {
        value: "self-hosted-vllm",
        label: "vLLM local",
        groupId: "local-runtimes",
        groupLabel: "Local runtimes",
      },
      resolveWizard: (provider: ProviderPlugin) => provider.wizard?.setup,
    },
    {
      name: "builds wizard options from method-level metadata",
      provider: makeProvider({
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
      }),
      choice: "openai-api-key",
      expectedOption: {
        value: "openai-api-key",
        label: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
        onboardingScopes: ["text-inference"],
      },
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
  ] as const)("$name", ({ provider, choice, expectedOption, resolveWizard }) => {
    expectSingleWizardChoice({
      provider,
      choice,
      expectedOption,
      expectedWizard: resolveWizard(provider),
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
    setResolvedProviders(provider);

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
    setResolvedProviders(provider);

    expect(resolveProviderModelPickerEntries({})).toEqual([
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
  });

  it("reuses provider resolution across wizard consumers for the same config and env", () => {
    const provider = createSglangWizardProvider({ includeModelPicker: true });
    const config = {};
    const env = createHomeEnv();
    setResolvedProviders(provider);

    const runtimeParams = createWizardRuntimeParams({ config, env });
    expect(resolveProviderWizardOptions(runtimeParams)).toHaveLength(1);
    expect(resolveProviderModelPickerEntries(runtimeParams)).toHaveLength(1);

    expectProviderResolutionCall({ config, env });
  });

  it("invalidates the wizard cache when config or env contents change in place", () => {
    const provider = createSglangSetupProvider();
    const config = createSglangConfig();
    const env = createHomeEnv("-a");
    setResolvedProviders(provider);

    expect(resolveProviderWizardOptions(createWizardRuntimeParams({ config, env }))).toHaveLength(
      1,
    );

    config.plugins.allow = ["vllm"];
    env.OPENCLAW_HOME = "/tmp/openclaw-home-b";

    expect(resolveProviderWizardOptions(createWizardRuntimeParams({ config, env }))).toHaveLength(
      1,
    );

    expectProviderResolutionCall({ config, env, count: 2 });
  });

  it.each([
    {
      name: "skips provider-wizard memoization when plugin cache opt-outs are set",
      env: createHomeEnv("", {
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
      }),
    },
    {
      name: "skips provider-wizard memoization when discovery cache ttl is zero",
      env: createHomeEnv("", {
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "0",
      }),
    },
  ] as const)("$name", ({ env }) => {
    const provider = createSglangSetupProvider();
    const config = createSglangConfig();
    setResolvedProviders(provider);

    expectWizardProviderCacheMiss({ config, env });
  });

  it("expires provider-wizard memoization after the shortest plugin cache ttl", () => {
    vi.useFakeTimers();
    const provider = createSglangSetupProvider();
    const config = {};
    const env = createHomeEnv("", {
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5",
      OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: "20",
    });
    setResolvedProviders(provider);
    const runtimeParams = createWizardRuntimeParams({ config, env });

    resolveProviderWizardOptions(runtimeParams);
    vi.advanceTimersByTime(4);
    resolveProviderWizardOptions(runtimeParams);
    vi.advanceTimersByTime(2);
    resolveProviderWizardOptions(runtimeParams);

    expectProviderResolutionCall({ config, env, count: 2 });
  });

  it("invalidates provider-wizard snapshots when cache-control env values change in place", () => {
    const provider = createSglangSetupProvider();
    const config = {};
    const env = createHomeEnv("", {
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "1000",
    });
    setResolvedProviders(provider);

    resolveProviderWizardOptions(createWizardRuntimeParams({ config, env }));

    env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "5";

    resolveProviderWizardOptions(createWizardRuntimeParams({ config, env }));

    expectProviderResolutionCall({ config, env, count: 2 });
  });

  it("routes model-selected hooks only to the matching provider", async () => {
    const matchingHook = vi.fn(async () => {});
    const otherHook = vi.fn(async () => {});
    setResolvedProviders(
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
    );

    const env = createHomeEnv();
    await runProviderModelSelectedHook({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env,
    });

    expectProviderResolutionCall({
      config: {},
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
