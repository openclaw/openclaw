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
vi.mock("./providers.js", () => ({
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
  });

  it("uses explicit onboarding choice ids and bound method ids", () => {
    const provider = makeProvider({
      id: "vllm",
      label: "vLLM",
      auth: [
        { id: "local", label: "Local", kind: "custom", run: vi.fn() },
        { id: "cloud", label: "Cloud", kind: "custom", run: vi.fn() },
      ],
      wizard: {
        onboarding: {
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
