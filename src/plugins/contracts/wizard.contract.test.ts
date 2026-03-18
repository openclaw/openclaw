import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin } from "../types.js";

const resolvePluginProvidersMock = vi.fn();

vi.mock("../providers.js", () => ({
  resolvePluginProviders: (...args: unknown[]) => resolvePluginProvidersMock(...args),
}));

let buildProviderPluginMethodChoice: typeof import("../provider-wizard.js").buildProviderPluginMethodChoice;
let providerContractPluginIds: typeof import("./registry.js").providerContractPluginIds;
let resolveProviderModelPickerEntries: typeof import("../provider-wizard.js").resolveProviderModelPickerEntries;
let resolveProviderPluginChoice: typeof import("../provider-wizard.js").resolveProviderPluginChoice;
let resolveProviderWizardOptions: typeof import("../provider-wizard.js").resolveProviderWizardOptions;
let uniqueProviderContractProviders: typeof import("./registry.js").uniqueProviderContractProviders;

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
  beforeEach(async () => {
    vi.resetModules();
    ({ providerContractPluginIds, uniqueProviderContractProviders } =
      await import("./registry.js"));
    ({
      buildProviderPluginMethodChoice,
      resolveProviderModelPickerEntries,
      resolveProviderPluginChoice,
      resolveProviderWizardOptions,
    } = await import("../provider-wizard.js"));
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue(uniqueProviderContractProviders);
  });

  it("exposes every registered provider setup choice through the shared wizard layer", () => {
    const options = resolveProviderWizardOptions({
      config: {
        plugins: {
          enabled: true,
          allow: providerContractPluginIds,
          slots: {
            memory: "none",
          },
        },
      },
      env: process.env,
    });

    expect(
      options.map((option) => option.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedWizardChoiceValues(uniqueProviderContractProviders));
    expect(options.map((option) => option.value)).toEqual([
      ...new Set(options.map((option) => option.value)),
    ]);
  });

  it("round-trips every shared wizard choice back to its provider and auth method", () => {
    for (const option of resolveProviderWizardOptions({ config: {}, env: process.env })) {
      const resolved = resolveProviderPluginChoice({
        providers: uniqueProviderContractProviders,
        choice: option.value,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.provider.id).toBeTruthy();
      expect(resolved?.method.id).toBeTruthy();
    }
  });

  it("exposes every registered model-picker entry through the shared wizard layer", () => {
    const entries = resolveProviderModelPickerEntries({ config: {}, env: process.env });

    expect(
      entries.map((entry) => entry.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedModelPickerValues(uniqueProviderContractProviders));
    for (const entry of entries) {
      const resolved = resolveProviderPluginChoice({
        providers: uniqueProviderContractProviders,
        choice: entry.value,
      });
      expect(resolved).not.toBeNull();
    }
  });
});
