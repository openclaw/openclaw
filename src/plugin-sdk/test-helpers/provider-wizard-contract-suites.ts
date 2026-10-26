import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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

const TEST_PROVIDERS: ProviderPlugin[] = [
  createProvider(
    "alpha",
    [createAuthMethod("api-key", {}), createAuthMethod("oauth", { choiceId: "alpha-oauth" })],
    { modelPicker: { label: "Alpha custom", hint: "Pick Alpha models", methodId: "oauth" } },
  ),
  createProvider("beta", [createAuthMethod("token")], {
    setup: {},
    modelPicker: { label: "Beta custom" },
  }),
  createProvider("gamma", [createAuthMethod("default"), createAuthMethod("alt")], {
    setup: { methodId: "alt", choiceId: "gamma-alt" },
  }),
];

export function describeProviderWizardChoiceResolutionContract() {
  describe("provider wizard choice resolution contract", () => {
    it.each([
      ["provider-plugin:alpha:api-key", "alpha", "api-key", "method"],
      ["alpha", "alpha", "api-key", "method"],
      ["alpha-oauth", "alpha", "oauth", "method"],
      ["beta", "beta", "token", "provider"],
      ["gamma-alt", "gamma", "alt", "provider"],
    ])(
      "%s resolves the exact provider, method, and wizard",
      (choice, providerId, methodId, source) => {
        const provider = expectDefined(
          TEST_PROVIDERS.find((entry) => entry.id === providerId),
          "fixture provider",
        );
        const method = expectDefined(
          provider.auth.find((entry) => entry.id === methodId),
          "fixture auth method",
        );
        const wizard = source === "method" ? method.wizard : provider.wizard?.setup;
        const resolved = resolveProviderPluginChoice({ providers: TEST_PROVIDERS, choice });

        expect(resolved?.provider).toBe(provider);
        expect(resolved?.method).toBe(method);
        expect(resolved?.wizard).toBe(wizard);
      },
    );
  });
}

export function describeProviderWizardModelPickerContract() {
  describe("provider wizard model picker contract", () => {
    it("exposes every model-picker entry through the shared wizard layer", () => {
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
  });
}
