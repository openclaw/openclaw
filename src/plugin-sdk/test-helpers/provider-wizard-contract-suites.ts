import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../plugins/provider-auth-choice.runtime.js";
import { resolveProviderModelPickerEntries } from "../../plugins/provider-wizard.js";
import * as providerRuntime from "../../plugins/providers.runtime.js";
import type { ProviderAuthMethod } from "../plugin-entry.js";
import type { ProviderPlugin } from "../provider-model-shared.js";

function createAuthMethod(id: string, wizard?: ProviderAuthMethod["wizard"]): ProviderAuthMethod {
  return {
    id,
    label: id,
    ...(wizard ? { wizard } : {}),
    kind: "api_key",
    run: async () => ({ profiles: [] }),
  };
}

const createProvider = (
  id: string,
  auth: ProviderAuthMethod[],
  wizard: ProviderPlugin["wizard"],
): ProviderPlugin => ({ id, label: id, auth, wizard });

const alpha = createProvider(
  "alpha",
  [createAuthMethod("api-key", {}), createAuthMethod("oauth", { choiceId: "alpha-oauth" })],
  { modelPicker: { label: "Alpha custom", hint: "Pick Alpha models", methodId: "oauth" } },
);
const beta = createProvider("beta", [createAuthMethod("token")], {
  setup: {},
  modelPicker: { label: "Beta custom" },
});
const gamma = createProvider("gamma", [createAuthMethod("default"), createAuthMethod("alt")], {
  setup: { methodId: "alt", choiceId: "gamma-alt" },
});
const TEST_PROVIDERS = [alpha, beta, gamma];

export function describeProviderWizardChoiceResolutionContract() {
  it.each([
    ["provider-plugin:alpha:api-key", alpha, 0, "method"],
    ["alpha", alpha, 0, "method"],
    ["alpha-oauth", alpha, 1, "method"],
    ["beta", beta, 0, "provider"],
    ["gamma-alt", gamma, 1, "provider"],
  ] as const)(
    "provider wizard choice resolution contract: %s resolves the exact provider, method, and wizard",
    (choice, provider, methodIndex, source) => {
      const method = expectDefined(provider.auth[methodIndex], "fixture auth method");
      const wizard = source === "method" ? method.wizard : provider.wizard?.setup;
      const resolved = resolveProviderPluginChoice({ providers: TEST_PROVIDERS, choice });

      expect(resolved?.provider).toBe(provider);
      expect(resolved?.method).toBe(method);
      expect(resolved?.wizard).toBe(wizard);
    },
  );
}

export function describeProviderWizardModelPickerContract() {
  it("provider wizard model picker contract: exposes every model-picker entry through the shared wizard layer", () => {
    const resolver = vi.spyOn(providerRuntime, "resolvePluginProvidersCore");
    resolver.mockReturnValue(TEST_PROVIDERS);
    onTestFinished(() => resolver.mockRestore());
    const entries = resolveProviderModelPickerEntries({ config: {}, env: process.env });

    const values = entries.map((entry) => entry.value);
    expect(values.toSorted()).toEqual(["beta", "provider-plugin:alpha:oauth"]);
    expect(
      values.every((choice) =>
        Boolean(resolveProviderPluginChoice({ providers: TEST_PROVIDERS, choice })),
      ),
      values.join(", "),
    ).toBe(true);
  });
}
