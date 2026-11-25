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

it("normalizes provider metadata and preserves default OAuth repairs", () => {
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
    oauthProfileIdRepairs: [
      {},
      { legacyProfileId: "demo:old", promptLabel: "Legacy profile" },
      { promptLabel: "Choose a profile" },
    ],
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
    oauthProfileIdRepairs: [
      {},
      { legacyProfileId: "   ", promptLabel: "" },
      { legacyProfileId: " demo:old ", promptLabel: " Legacy profile " },
      { legacyProfileId: " ", promptLabel: " Choose a profile " },
    ],
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
  expect(diagnostics.map(({ level }) => level)).toEqual(["error", "error", "warn", "warn"]);
});

it.each([{ deprecatedProfileIds: ["", "   "] }, { oauthProfileIdRepairs: [] }])(
  "omits discarded profile metadata: %j",
  (overrides) => {
    const { provider, diagnostics } = normalize(overrides);
    expect(provider).not.toHaveProperty(Object.keys(overrides)[0]!);
    expect(diagnostics).toEqual([]);
  },
);

it("drops wizard metadata when a provider has no auth methods", () => {
  const { provider, diagnostics } = normalize({
    wizard: { setup: { choiceId: "demo" }, modelPicker: { label: "Demo" } },
  });
  expect(provider?.wizard).toBeUndefined();
  expect(diagnostics.map(({ level }) => level)).toEqual(["warn", "warn"]);
});
