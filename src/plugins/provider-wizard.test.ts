// Covers provider setup wizard prompts supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoiceCore,
  runProviderModelSelectedHookCore,
} from "./provider-wizard.js";
import type { ProviderPlugin } from "./types.js";

const resolvePluginProvidersCore = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProvidersCore,
}));

const DEFAULT_WORKSPACE_DIR = "/tmp/workspace";

function makeProvider(overrides: Partial<ProviderPlugin> & Pick<ProviderPlugin, "id" | "label">) {
  return {
    auth: [],
    ...overrides,
  } satisfies ProviderPlugin;
}

describe("manifest auth choice dispatch", () => {
  const manifestChoice = {
    pluginId: "moonshot",
    providerId: "moonshot",
    methodId: "api-key-cn",
    choiceId: "moonshot-api-key-cn",
  };
  const provider = makeProvider({
    id: "moonshot",
    pluginId: "moonshot",
    label: "Moonshot",
    auth: [
      { id: "api-key", label: "Global", kind: "api_key", run: vi.fn() },
      {
        id: "api-key-cn",
        label: "China",
        kind: "api_key",
        wizard: { groupLabel: "Moonshot", modelSelection: { allowKeepCurrent: false } },
        run: vi.fn(),
      },
    ],
  });

  it("resolves the declared method without a duplicate runtime choice ID", () => {
    expect(
      resolveProviderPluginChoiceCore({
        providers: [{ ...provider, pluginId: "other-plugin" }, provider],
        choice: manifestChoice.choiceId,
        manifestChoice,
      }),
    ).toEqual({ provider, method: provider.auth[1], wizard: provider.auth[1]?.wizard });
  });

  it.each([manifestChoice.choiceId, buildProviderPluginMethodChoice(provider.id, "api-key-cn")])(
    "keeps manifest-owned utility selection on the resolved setup method: %s",
    (choice) => {
      const resolved = resolveProviderPluginChoiceCore({
        providers: [provider],
        choice,
        manifestChoice: { ...manifestChoice, modelTarget: "utility" },
      });
      expect(resolved?.wizard).toMatchObject({
        modelTarget: "utility",
        modelSelection: { allowKeepCurrent: false },
      });
    },
  );

  it.each([
    { pluginId: "other-plugin", providerId: "other-provider", methodId: "api-key-cn" },
    { pluginId: "other-plugin", providerId: "moonshot", methodId: "api-key" },
    { pluginId: "moonshot", providerId: "moonshot", methodId: "api-key-cn" },
  ])(
    "preserves explicit provider-method targets over a conflicting manifest choice: %j",
    (identity) => {
      const choice = buildProviderPluginMethodChoice(provider.id, "api-key");
      expect(
        resolveProviderPluginChoiceCore({
          providers: [{ ...provider, id: "other-provider", pluginId: "other-plugin" }, provider],
          choice,
          manifestChoice: {
            ...manifestChoice,
            ...identity,
            choiceId: choice,
            modelTarget: "utility",
          },
        }),
      ).toEqual({ provider, method: provider.auth[0] });
    },
  );

  it.each([
    { pluginId: "other-plugin" },
    { providerId: "other-provider" },
    { methodId: "missing" },
    { methodId: "" },
    { choiceId: "other-choice" },
  ])("rejects an unmatched manifest identity: %j", (override) => {
    const conflictingRuntime = {
      ...provider,
      auth: provider.auth.map((method) =>
        Object.assign({}, method, { wizard: { choiceId: manifestChoice.choiceId } }),
      ),
    };
    expect(
      resolveProviderPluginChoiceCore({
        providers: [conflictingRuntime],
        choice: manifestChoice.choiceId,
        manifestChoice: { ...manifestChoice, ...override },
      }),
    ).toBeNull();
  });

  it("preserves exact manifest choice dispatch when a provider has the same bare ID", () => {
    const other = { ...provider, id: "other-provider", pluginId: "other-plugin" };
    expect(
      resolveProviderPluginChoiceCore({
        providers: [provider, other],
        choice: provider.id,
        manifestChoice: {
          ...manifestChoice,
          pluginId: other.pluginId,
          providerId: other.id,
          choiceId: provider.id,
        },
      }),
    ).toEqual({ provider: other, method: other.auth[1], wizard: other.auth[1]?.wizard });
  });
});

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
  providerRefs?: readonly string[];
  count?: number;
}) {
  expect(resolvePluginProvidersCore).toHaveBeenCalledTimes(params?.count ?? 1);
  expect(resolvePluginProvidersCore).toHaveBeenCalledWith({
    ...createWizardRuntimeParams(params),
    mode: "setup",
    ...(params?.providerRefs ? { providerRefs: params.providerRefs } : {}),
  });
}

function setResolvedProviders(...providers: ProviderPlugin[]) {
  resolvePluginProvidersCore.mockReturnValue(providers);
}

function expectSingleWizardChoice(params: {
  provider: ProviderPlugin;
  choice: string;
  expectedWizard: unknown;
}) {
  expect(
    resolveProviderPluginChoiceCore({
      providers: [params.provider],
      choice: params.choice,
    }),
  ).toEqual({
    provider: params.provider,
    method: params.provider.auth[0],
    wizard: params.expectedWizard,
  });
}

function expectModelPickerEntries(
  provider: ProviderPlugin,
  expected: Array<{
    value: string;
    label: string;
    hint?: string;
  }>,
) {
  setResolvedProviders(provider);
  expect(resolveProviderModelPickerEntries({})).toEqual(expected);
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
      resolveWizard: (provider: ProviderPlugin) => provider.wizard?.setup,
    },
    {
      name: "resolves choices from method-level wizard metadata",
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
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      name: "returns method wizard metadata for media-only choices",
      provider: makeProvider({
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
      }),
      choice: "fal-api-key",
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
    {
      name: "returns method wizard metadata for canonical choices",
      provider: makeProvider({
        id: "anthropic",
        label: "Anthropic",
        auth: [
          {
            id: "cli",
            label: "Claude CLI",
            kind: "custom",
            wizard: {
              choiceId: "anthropic-cli",
              modelAllowlist: {
                allowedKeys: ["claude-cli/claude-sonnet-4-6"],
                initialSelections: ["claude-cli/claude-sonnet-4-6"],
                message: "Claude CLI models",
              },
            },
            run: vi.fn(),
          },
        ],
      }),
      choice: "anthropic-cli",
      resolveWizard: (provider: ProviderPlugin) => provider.auth[0]?.wizard,
    },
  ] as const)("$name", ({ provider, choice, resolveWizard }) => {
    expectSingleWizardChoice({
      provider,
      choice,
      expectedWizard: resolveWizard(provider),
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
    expectModelPickerEntries(provider, [
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
  });

  it("resolves providers in setup mode for the model picker", () => {
    const provider = createSglangWizardProvider({ includeModelPicker: true });
    const config = {};
    const env = createHomeEnv();
    setResolvedProviders(provider);

    const runtimeParams = createWizardRuntimeParams({ config, env });
    expect(resolveProviderModelPickerEntries(runtimeParams)).toHaveLength(1);

    expectProviderResolutionCall({ config, env });
  });

  it("uses the prepared matching provider when the runtime inventory does not contain it", async () => {
    const onModelSelected = vi.fn(async () => {});
    const preparedProvider = makeProvider({ id: "VLLM", label: "vLLM", onModelSelected });
    const prompter = createWizardPrompter();
    await runProviderModelSelectedHookCore({
      config: {},
      model: "vllm/fixture-model",
      prompter,
      env: createHomeEnv(),
      preparedProvider,
    });
    expect(onModelSelected).toHaveBeenCalledOnce();
    expect(onModelSelected).toHaveBeenCalledWith({
      config: {},
      model: "vllm/fixture-model",
      prompter,
      agentDir: undefined,
      workspaceDir: undefined,
    });
    expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
  });

  it("resolves a different model owner instead of using the prepared authentication provider", async () => {
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
    await runProviderModelSelectedHookCore({
      config: {},
      model: "vllm/qwen3-coder",
      prompter: {} as never,
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      env,
      preparedProvider: makeProvider({ id: "ollama", label: "Ollama", onModelSelected: otherHook }),
    });

    expectProviderResolutionCall({
      config: {},
      env,
      providerRefs: ["vllm"],
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
