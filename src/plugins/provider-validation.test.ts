import { expect, it } from "vitest";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

function normalize(overrides: Partial<ProviderPlugin>) {
  const builder = createTestPluginRegistry();
  const record = createOwnershipRecord("demo-plugin", { source: "/tmp/demo/index.ts" });
  builder.registerProvider(record, { id: "demo", label: "Demo", auth: [], ...overrides });
  return {
    provider: builder.registry.providers[0]?.provider,
    diagnostics: builder.registry.diagnostics,
  };
}

it("drops invalid and duplicate auth methods, and clears bad wizard method bindings", () => {
  const method: ProviderAuthMethod = {
    id: "primary",
    label: "Primary",
    kind: "custom",
    run: async () => ({ profiles: [] }),
    wizard: {
      choiceId: "demo-primary",
      modelTarget: "utility",
      assistantVisibility: "detected-only",
      onboardingFeatured: true,
      modelSelection: { promptWhenAuthChoiceProvided: true, allowKeepCurrent: false },
      modelAllowlist: {
        allowedKeys: ["demo/model"],
        initialSelections: ["demo/model"],
        loadCatalog: true,
        message: "Demo models",
      },
    },
  };
  const expected: ProviderPlugin = {
    id: "demo",
    label: "Demo Provider",
    aliases: ["alias-one"],
    deprecatedProfileIds: ["demo:legacy"],
    envVars: ["DEMO_API_KEY"],
    auth: [method],
    wizard: {
      setup: {
        choiceId: "demo-choice",
        onboardingFeatured: true,
        modelSelection: { promptWhenAuthChoiceProvided: false, allowKeepCurrent: true },
      },
      modelPicker: { label: "Demo models" },
    },
  };
  const { provider, diagnostics } = normalize({
    ...expected,
    id: " demo ",
    label: " Demo Provider ",
    aliases: [" alias-one ", "alias-one", ""],
    deprecatedProfileIds: [" demo:legacy ", "demo:legacy", ""],
    envVars: [" DEMO_API_KEY ", "DEMO_API_KEY"],
    auth: [
      {
        ...method,
        id: " primary ",
        label: " Primary ",
        wizard: {
          ...method.wizard,
          choiceId: " demo-primary ",
          modelAllowlist: {
            ...method.wizard?.modelAllowlist,
            allowedKeys: [" demo/model ", "demo/model"],
            initialSelections: [" demo/model "],
            message: " Demo models ",
          },
        },
      },
      { ...method, id: "primary", label: "Duplicate", wizard: undefined },
      { ...method, id: "   ", label: "Missing", wizard: undefined },
    ],
    wizard: {
      setup: { ...expected.wizard?.setup, choiceId: " demo-choice ", methodId: " missing " },
      modelPicker: { label: " Demo models ", methodId: " missing " },
    },
  });
  expect(provider).toEqual({ ...expected, pluginRoot: undefined });
  expect(diagnostics.map(({ level, message }) => [level, message])).toEqual([
    ["error", 'provider "demo" auth method duplicated id "primary"'],
    ["error", 'provider "demo" auth method missing id'],
    ["warn", 'provider "demo" setup method "missing" not found; falling back to available methods'],
    [
      "warn",
      'provider "demo" model-picker method "missing" not found; falling back to available methods',
    ],
  ]);
});

it("drops wizard metadata when a provider has no auth methods", () => {
  const { provider, diagnostics } = normalize({
    wizard: { setup: { choiceId: "demo" }, modelPicker: { label: "Demo" } },
  });
  expect(provider?.wizard).toBeUndefined();
  expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
    'provider "demo" setup metadata ignored because it has no auth methods',
    'provider "demo" model-picker metadata ignored because it has no auth methods',
  ]);
});
