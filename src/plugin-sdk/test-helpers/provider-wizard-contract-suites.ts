/**
 * Contract suites for provider setup wizard choice resolution and model pickers.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProviderPluginChoice } from "../../plugins/provider-auth-choice.runtime.js";
import {
  resolveProviderModelPickerEntries,
  setProviderWizardProvidersResolverForTest,
} from "../../plugins/provider-wizard.js";
import type { ProviderAuthMethod } from "../plugin-entry.js";
import type { ProviderPlugin } from "../provider-model-shared.js";

const resolvePluginProvidersMock = vi.fn();
let restoreProviderResolver: (() => void) | undefined;

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
          modelTarget: "utility",
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

function sortedValues(values: readonly string[]) {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function expectAllChoicesResolve(
  values: readonly string[],
  resolver: (choice: string) => ReturnType<typeof resolveProviderPluginChoice>,
) {
  expect(
    values.every((value) => Boolean(resolver(value))),
    values.join(", "),
  ).toBe(true);
}

beforeEach(() => {
  resolvePluginProvidersMock.mockReset();
  resolvePluginProvidersMock.mockReturnValue(TEST_PROVIDERS);
  restoreProviderResolver?.();
  restoreProviderResolver = setProviderWizardProvidersResolverForTest((params) =>
    resolvePluginProvidersMock(params),
  );
});

afterEach(() => {
  restoreProviderResolver?.();
  restoreProviderResolver = undefined;
});

export function describeProviderWizardChoiceResolutionContract() {
  describe("provider wizard choice resolution contract", () => {
    it.each([
      {
        name: "an explicit provider-method choice",
        choice: "provider-plugin:alpha:api-key",
        providerId: "alpha",
        methodId: "api-key",
        wizardSource: "method",
      },
      {
        name: "a bare provider choice",
        choice: "alpha",
        providerId: "alpha",
        methodId: "api-key",
        wizardSource: "method",
      },
      {
        name: "a method-level wizard choice",
        choice: "alpha-oauth",
        providerId: "alpha",
        methodId: "oauth",
        wizardSource: "method",
      },
      {
        name: "a single-method provider setup choice",
        choice: "beta",
        providerId: "beta",
        methodId: "token",
        wizardSource: "provider",
      },
      {
        name: "an explicit provider setup method",
        choice: "gamma-alt",
        providerId: "gamma",
        methodId: "alt",
        wizardSource: "provider",
      },
    ])("$name resolves the exact provider, method, and wizard", (row) => {
      const provider = expectDefined(
        TEST_PROVIDERS.find((entry) => entry.id === row.providerId),
        "fixture provider",
      );
      const method = expectDefined(
        provider.auth.find((entry) => entry.id === row.methodId),
        "fixture auth method",
      );
      const wizard =
        row.wizardSource === "method"
          ? method.wizard
          : row.wizardSource === "provider"
            ? provider.wizard?.setup
            : undefined;
      const resolved = resolveProviderPluginChoice({
        providers: TEST_PROVIDERS,
        choice: row.choice,
      });

      expect(resolved?.provider).toBe(provider);
      expect(resolved?.method).toBe(method);
      expect(resolved?.wizard).toBe(wizard);
    });
  });
}

export function describeProviderWizardModelPickerContract() {
  describe("provider wizard model picker contract", () => {
    it("exposes every model-picker entry through the shared wizard layer", () => {
      const entries = resolveProviderModelPickerEntries({ config: {}, env: process.env });

      expect(sortedValues(entries.map((entry) => entry.value))).toEqual([
        "beta",
        "provider-plugin:alpha:oauth",
      ]);
      expectAllChoicesResolve(
        entries.map((entry) => entry.value),
        (choice) =>
          resolveProviderPluginChoice({
            providers: TEST_PROVIDERS,
            choice,
          }),
      );
    });
  });
}
