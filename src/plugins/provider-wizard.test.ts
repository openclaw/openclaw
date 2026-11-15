// Covers provider setup wizard prompts supplied by plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoiceCore,
  runProviderModelSelectedHookCore,
} from "./provider-wizard.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

const resolvePluginProvidersCore = vi.hoisted(() => vi.fn<() => ProviderPlugin[]>(() => []));
vi.mock("./providers.runtime.js", () => ({
  isPluginProvidersLoadInFlight: () => false,
  resolvePluginProvidersCore,
}));

function makeProvider(id: string, overrides: Partial<ProviderPlugin> = {}): ProviderPlugin {
  return { id, label: id, auth: [], ...overrides };
}

function auth(id: string, wizard?: ProviderAuthMethod["wizard"]): ProviderAuthMethod {
  return { id, label: id, kind: "custom", run: vi.fn(), ...(wizard ? { wizard } : {}) };
}

describe("manifest auth choice dispatch", () => {
  const manifestChoice = {
    pluginId: "moonshot",
    providerId: "moonshot",
    methodId: "api-key-cn",
    choiceId: "moonshot-api-key-cn",
  };
  const provider = makeProvider("moonshot", {
    pluginId: "moonshot",
    label: "Moonshot",
    auth: [
      auth("api-key"),
      auth("api-key-cn", {
        groupLabel: "Moonshot",
        modelSelection: { allowKeepCurrent: false },
      }),
    ],
  });
  const resolve = (choice: string, metadata = manifestChoice, providers = [provider]) =>
    resolveProviderPluginChoiceCore({ providers, choice, manifestChoice: metadata });

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
          choice,
          providers: [{ ...provider, id: "other-provider", pluginId: "other-plugin" }, provider],
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
      resolve(manifestChoice.choiceId, { ...manifestChoice, ...override }, [conflictingRuntime]),
    ).toBeNull();
  });

  it("preserves exact manifest choice dispatch when a provider has the same bare ID", () => {
    const other = { ...provider, id: "other-provider", pluginId: "other-plugin" };
    expect(
      resolve(
        provider.id,
        {
          ...manifestChoice,
          pluginId: other.pluginId,
          providerId: other.id,
          choiceId: provider.id,
        },
        [provider, other],
      ),
    ).toEqual({ provider: other, method: other.auth[1], wizard: other.auth[1]?.wizard });
  });
});

const env = { OPENCLAW_HOME: "/tmp/openclaw-home" };

describe("provider wizard boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("builds model-picker entries from plugin metadata and provider-method choices", () => {
    const provider = makeProvider("sglang", {
      auth: [auth("server"), auth("cloud")],
      wizard: {
        modelPicker: {
          label: "SGLang server",
          hint: "OpenAI-compatible local runtime",
          methodId: "server",
        },
      },
    });
    const config = {};
    const params = { config, workspaceDir: "/tmp/workspace", env };
    resolvePluginProvidersCore.mockReturnValue([provider]);
    expect(resolveProviderModelPickerEntries(params)).toEqual([
      {
        value: buildProviderPluginMethodChoice("sglang", "server"),
        label: "SGLang server",
        hint: "OpenAI-compatible local runtime",
      },
    ]);
    expect(resolvePluginProvidersCore).toHaveBeenCalledWith({
      ...params,
      mode: "setup",
    });
  });

  it.each([true, false])(
    "calls the selected model owner (prepared matches=%s)",
    async (matches) => {
      const matchingHook = vi.fn(async () => {});
      const otherHook = vi.fn(async () => {});
      const selected = makeProvider("VLLM", { onModelSelected: matchingHook });
      const other = makeProvider("ollama", { onModelSelected: otherHook });
      resolvePluginProvidersCore.mockReturnValue([other, selected]);
      const params = {
        config: {},
        model: "vllm/fixture-model",
        prompter: createWizardPrompter(),
        agentDir: matches ? undefined : "/tmp/agent",
        workspaceDir: matches ? undefined : "/tmp/workspace",
      };
      if (matches) {
        resolvePluginProvidersCore.mockReturnValue([]);
      }
      await runProviderModelSelectedHookCore({
        ...params,
        env,
        preparedProvider: matches ? selected : other,
      });
      expect(matchingHook).toHaveBeenCalledOnce();
      expect(matchingHook).toHaveBeenCalledWith(params);
      expect(otherHook).not.toHaveBeenCalled();
      if (matches) {
        expect(resolvePluginProvidersCore).not.toHaveBeenCalled();
      }
    },
  );
});
