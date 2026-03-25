import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildProviderPluginMethodChoice,
  resolveProviderModelPickerEntries,
  resolveProviderPluginChoice,
  resolveProviderWizardOptions,
} from "../provider-wizard.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../types.js";

const resolvePluginProvidersMock = vi.fn();

vi.mock("../providers.runtime.js", () => ({
  resolvePluginProviders: (...args: unknown[]) => resolvePluginProvidersMock(...args),
}));

function createAuthMethod(
  params: Pick<ProviderAuthMethod, "id" | "label"> &
    Partial<Pick<ProviderAuthMethod, "hint" | "wizard">>,
): ProviderAuthMethod {
  return {
    id: params.id,
    label: params.label,
    ...(params.hint ? { hint: params.hint } : {}),
    ...(params.wizard ? { wizard: params.wizard } : {}),
    kind: "api_key",
    run: async () => ({ profiles: [] }),
  };
}

const TEST_PROVIDERS: ProviderPlugin[] = [
  {
    id: "alpha",
    label: "Alpha",
    auth: [
      createAuthMethod({
        id: "api-key",
        label: "API key",
        wizard: {
          choiceLabel: "Alpha key",
          choiceHint: "Use an API key",
          groupId: "alpha",
          groupLabel: "Alpha",
          onboardingScopes: ["text-inference"],
        },
      }),
      createAuthMethod({
        id: "oauth",
        label: "OAuth",
        wizard: {
          choiceId: "alpha-oauth",
          choiceLabel: "Alpha OAuth",
          groupId: "alpha",
          groupLabel: "Alpha",
          groupHint: "Recommended",
        },
      }),
    ],
    wizard: {
      modelPicker: {
        label: "Alpha custom",
        hint: "Pick Alpha models",
        methodId: "oauth",
      },
    },
  },
  {
    id: "beta",
    label: "Beta",
    auth: [createAuthMethod({ id: "token", label: "Token" })],
    wizard: {
      setup: {
        choiceLabel: "Beta setup",
        groupId: "beta",
        groupLabel: "Beta",
      },
      modelPicker: {
        label: "Beta custom",
      },
    },
  },
  {
    id: "gamma",
    label: "Gamma",
    auth: [
      createAuthMethod({ id: "default", label: "Default auth" }),
      createAuthMethod({ id: "alt", label: "Alt auth" }),
    ],
    wizard: {
      setup: {
        methodId: "alt",
        choiceId: "gamma-alt",
        choiceLabel: "Gamma alt",
        groupId: "gamma",
        groupLabel: "Gamma",
      },
    },
  },
];

const TEST_PROVIDER_IDS = TEST_PROVIDERS.map((provider) => provider.id).toSorted((left, right) =>
  left.localeCompare(right),
);

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

    if (provider.auth.length === 1) {
      values.push(setup.choiceId?.trim() || provider.id);
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
  beforeEach(() => {
    resolvePluginProvidersMock.mockReset();
    resolvePluginProvidersMock.mockReturnValue(TEST_PROVIDERS);
  });

  it("exposes every wizard setup choice through the shared wizard layer", () => {
    const options = resolveProviderWizardOptions({
      config: {
        plugins: {
          enabled: true,
          allow: TEST_PROVIDER_IDS,
          slots: {
            memory: "none",
          },
        },
      },
      env: process.env,
    });

    expect(
      options.map((option) => option.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedWizardChoiceValues(TEST_PROVIDERS));
    expect(options.map((option) => option.value)).toEqual([
      ...new Set(options.map((option) => option.value)),
    ]);
  });

  it("round-trips every shared wizard choice back to its provider and auth method", () => {
    for (const option of resolveProviderWizardOptions({ config: {}, env: process.env })) {
      const resolved = resolveProviderPluginChoice({
        providers: TEST_PROVIDERS,
        choice: option.value,
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.provider.id).toBeTruthy();
      expect(resolved?.method.id).toBeTruthy();
    }
  });

  it("exposes every model-picker entry through the shared wizard layer", () => {
    const entries = resolveProviderModelPickerEntries({ config: {}, env: process.env });

    expect(
      entries.map((entry) => entry.value).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(resolveExpectedModelPickerValues(TEST_PROVIDERS));
    for (const entry of entries) {
      const resolved = resolveProviderPluginChoice({
        providers: TEST_PROVIDERS,
        choice: entry.value,
      });
      expect(resolved).not.toBeNull();
    }
  });
});
