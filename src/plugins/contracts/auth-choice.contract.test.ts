import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import { resolvePreferredProviderForAuthChoice } from "../../plugins/provider-auth-choice-preference.js";
import { buildProviderPluginMethodChoice } from "../provider-wizard.js";
import { requireProviderContractProvider, uniqueProviderContractProviders } from "./registry.js";

type ResolvePluginProviders =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolvePluginProviders;
type ResolveProviderPluginChoice =
  typeof import("../../plugins/provider-auth-choice.runtime.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook =
  typeof import("../../plugins/provider-auth-choice.runtime.js").runProviderModelSelectedHook;
const resolvePluginProvidersMock = vi.hoisted(() => vi.fn<ResolvePluginProviders>(() => []));
const resolveProviderPluginChoiceMock = vi.hoisted(() => vi.fn<ResolveProviderPluginChoice>());
const runProviderModelSelectedHookMock = vi.hoisted(() =>
  vi.fn<RunProviderModelSelectedHook>(async () => {}),
);

vi.mock("../../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
  resolveProviderPluginChoice: resolveProviderPluginChoiceMock,
  runProviderModelSelectedHook: runProviderModelSelectedHookMock,
}));

describe("provider auth-choice contract", () => {
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
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
    resolveProviderPluginChoiceMock.mockReset();
    resolveProviderPluginChoiceMock.mockReturnValue(null);
    runProviderModelSelectedHookMock.mockReset();
    clearRuntimeAuthProfileStoreSnapshots();
  });

  it("maps provider-plugin choices through the shared preferred-provider fallback resolver", async () => {
    const pluginFallbackScenarios = [
      "github-copilot",
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

    resolvePluginProvidersMock.mockClear();
    await expect(resolvePreferredProviderForAuthChoice({ choice: "unknown" })).resolves.toBe(
      undefined,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalled();
  });
});
