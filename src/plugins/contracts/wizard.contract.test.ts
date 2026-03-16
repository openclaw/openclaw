import { describe, expect, it } from "vitest";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
} from "../provider-wizard.js";
import { resolvePluginProviders } from "../providers.js";
import type { ProviderPlugin } from "../types.js";
import { providerContractRegistry } from "./registry.js";

function createBundledProviderConfig() {
  return {
    plugins: {
      enabled: true,
      allow: [...new Set(providerContractRegistry.map((entry) => entry.pluginId))],
      slots: {
        memory: "none",
      },
    },
  };
}

function resolveExpectedWizardChoiceValues(providers: ProviderPlugin[]) {
  const values: string[] = [];

  for (const provider of providers) {
    const methodSetups = provider.auth.filter((method) => method.wizard);
    if (methodSetups.length > 0) {
      values.push(
        ...methodSetups.map(
          (method) =>
            method.wizard?.choiceId?.trim() ||
            buildProviderPluginMethodChoice(provider.id, method.id),
        ),
      );
      continue;
    }

    const setup = provider.wizard?.setup;
    if (!setup) {
      continue;
    }

    const explicitMethodId = setup.methodId?.trim();
    if (explicitMethodId && provider.auth.some((method) => method.id === explicitMethodId)) {
      values.push(
        setup.choiceId?.trim() || buildProviderPluginMethodChoice(provider.id, explicitMethodId),
      );
      continue;
    }

    values.push(
      ...provider.auth.map((method) => buildProviderPluginMethodChoice(provider.id, method.id)),
    );
  }

  return values.toSorted((left, right) => left.localeCompare(right));
}

function resolveExpectedModelPickerValues(providers: ProviderPlugin[]) {
  return providers
    .flatMap((provider) => {
      const modelPicker = provider.wizard?.modelPicker;
      if (!modelPicker) {
        return [];
      }
      const explicitMethodId = modelPicker.methodId?.trim();
      if (explicitMethodId) {
        return [buildProviderPluginMethodChoice(provider.id, explicitMethodId)];
      }
      if (provider.auth.length === 1) {
        return [provider.id];
      }
      return [buildProviderPluginMethodChoice(provider.id, provider.auth[0]?.id ?? "default")];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

describe("provider wizard contract", () => {
  it("exposes every registered provider setup choice through the shared wizard layer", () => {
    const config = createBundledProviderConfig();
    const providers = resolvePluginProviders({
      config,
      env: process.env,
    });

    const options = resolveProviderWizardOptions({
      config,
      env: process.env,
    });

    expect(
      options.map((option) => option.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedWizardChoiceValues(providers));
    expect(options.map((option) => option.value)).toEqual([
      ...new Set(options.map((option) => option.value)),
    ]);
  });

  it("round-trips every shared wizard choice back to its provider and auth method", () => {
    const config = createBundledProviderConfig();
    const providers = resolvePluginProviders({
      config,
      env: process.env,
    });

    for (const option of resolveProviderWizardOptions({ config, env: process.env })) {
      const resolved = resolveProviderPluginChoice({
        providers,
        choice: option.value,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.provider.id).toBeTruthy();
      expect(resolved?.method.id).toBeTruthy();
    }
  });

  it("exposes every registered model-picker entry through the shared wizard layer", () => {
    const config = createBundledProviderConfig();
    const providers = resolvePluginProviders({
      config,
      env: process.env,
    });

    const entries = resolveProviderModelPickerEntries({
      config,
      env: process.env,
    });

    expect(
      entries.map((entry) => entry.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedModelPickerValues(providers));
    for (const entry of entries) {
      const resolved = resolveProviderPluginChoice({
        providers,
        choice: entry.value,
      });
      expect(resolved).not.toBeNull();
    }
  });
});
