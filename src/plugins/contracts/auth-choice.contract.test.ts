// Auth choice contract tests cover provider auth choice metadata and setup behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
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
const resolvePluginSetupProviderMock = vi.hoisted(() => vi.fn(() => undefined));
const resolveProviderPluginChoiceMock = vi.hoisted(() => vi.fn<ResolveProviderPluginChoice>());
const runProviderModelSelectedHookMock = vi.hoisted(() =>
  vi.fn<RunProviderModelSelectedHook>(async () => {}),
);
const runAuthMethodMock = vi.hoisted(() => vi.fn(async () => ({ profiles: [] })));

vi.mock("../../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders: resolvePluginProvidersMock,
  resolvePluginSetupProvider: resolvePluginSetupProviderMock,
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
    const provider = {
      id: "demo-oauth-provider",
      label: "Demo OAuth Provider",
      auth: [{ id: "oauth", label: "OAuth", kind: "oauth", run: runAuthMethodMock }],
    } satisfies ProviderPlugin;
    resolvePluginProvidersMock.mockReturnValue([provider]);
    await expect(
      resolvePreferredProviderForAuthChoice({
        choice: buildProviderPluginMethodChoice(provider.id, "oauth"),
      }),
    ).resolves.toBe(provider.id);
    expect(resolvePluginProvidersMock).toHaveBeenCalled();

    resolvePluginProvidersMock.mockClear();
    await expect(resolvePreferredProviderForAuthChoice({ choice: "unknown" })).resolves.toBe(
      undefined,
    );
    expect(resolvePluginProvidersMock).toHaveBeenCalled();
  });
});
