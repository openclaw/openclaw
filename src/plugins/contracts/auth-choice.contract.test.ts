import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/store.js";
import { resolvePreferredProviderForAuthChoice } from "../../plugins/provider-auth-choice-preference.js";
import { buildProviderPluginMethodChoice } from "../provider-wizard.js";
import type { ProviderPlugin } from "../types.js";

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
const runAuthMethodMock = vi.hoisted(() => vi.fn(async () => ({ profiles: [] })));

vi.mock("../../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
  resolveProviderPluginChoice: resolveProviderPluginChoiceMock,
  runProviderModelSelectedHook: runProviderModelSelectedHookMock,
}));

describe("provider auth-choice contract", () => {
  beforeEach(() => {
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue([]);
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
    const pluginFallbackScenarios: ProviderPlugin[] = [
      {
        id: "demo-oauth-provider",
        label: "Demo OAuth Provider",
        auth: [
          {
            id: "oauth",
            label: "OAuth",
            hint: "Browser sign-in",
            kind: "oauth",
            run: runAuthMethodMock,
          },
        ],
      },
      {
        id: "demo-browser-provider",
        label: "Demo Browser Provider",
        auth: [
          {
            id: "portal",
            label: "Portal",
            hint: "Browser sign-in",
            kind: "oauth",
            run: runAuthMethodMock,
          },
        ],
      },
      {
        id: "demo-api-key-provider",
        label: "Demo API Key Provider",
        auth: [
          {
            id: "api-key",
            label: "API key",
            hint: "Paste key",
            kind: "api_key",
            run: runAuthMethodMock,
          },
        ],
      },
      {
        id: "demo-local-provider",
        label: "Demo Local Provider",
        auth: [
          {
            id: "local",
            label: "Local",
            hint: "No auth",
            kind: "custom",
            run: runAuthMethodMock,
          },
        ],
      },
    ];

    for (const provider of pluginFallbackScenarios) {
      resolvePluginProvidersMock.mockClear();
      resolvePluginProvidersMock.mockReturnValue([provider]);
      await expect(
        resolvePreferredProviderForAuthChoice({
          choice: buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default"),
        }),
      ).resolves.toBe(provider.id);
      expect(resolvePluginProvidersMock).toHaveBeenCalled();
    }

    resolvePluginProvidersMock.mockClear();
    await expect(resolvePreferredProviderForAuthChoice({ choice: "unknown" })).resolves.toBe(
      undefined,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalled();
  });
});
