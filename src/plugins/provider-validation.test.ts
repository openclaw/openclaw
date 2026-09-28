import { describe, expect, it } from "vitest";
import type { PluginDiagnostic } from "./manifest-types.js";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { ProviderPlugin } from "./types.js";

function makeProvider(overrides: Partial<ProviderPlugin>): ProviderPlugin {
  return { id: "demo", label: "Demo", auth: [], ...overrides };
}

function normalizeProviderFixture(provider: ProviderPlugin) {
  const diagnostics: PluginDiagnostic[] = [];
  const normalized = normalizeRegisteredProvider({
    pluginId: "demo-plugin",
    source: "/tmp/demo/index.ts",
    provider,
    pushDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { provider: normalized, diagnostics };
}

describe("normalizeRegisteredProvider", () => {
  it("drops invalid and duplicate auth methods, and clears bad wizard method bindings", () => {
    const primaryAuthRun = async () => ({ profiles: [] });
    const { provider, diagnostics } = normalizeProviderFixture(
      makeProvider({
        id: " demo ",
        label: " Demo Provider ",
        aliases: [" alias-one ", "alias-one", ""],
        deprecatedProfileIds: [" demo:legacy ", "demo:legacy", ""],
        envVars: [" DEMO_API_KEY ", "DEMO_API_KEY"],
        auth: [
          {
            id: " primary ",
            label: " Primary ",
            kind: "custom",
            wizard: {
              choiceId: " demo-primary ",
              modelTarget: "utility",
              assistantVisibility: "detected-only",
              onboardingFeatured: true,
              modelAllowlist: {
                allowedKeys: [" demo/model ", "demo/model"],
                initialSelections: [" demo/model "],
                loadCatalog: true,
                message: " Demo models ",
              },
            },
            run: primaryAuthRun,
          },
          {
            id: "primary",
            label: "Duplicate",
            kind: "custom",
            run: async () => ({ profiles: [] }),
          },
          { id: "   ", label: "Missing", kind: "custom", run: async () => ({ profiles: [] }) },
        ],
        wizard: {
          setup: {
            choiceId: " demo-choice ",
            onboardingFeatured: true,
            methodId: " missing ",
          },
          modelPicker: {
            label: " Demo models ",
            methodId: " missing ",
          },
        },
      }),
    );
    expect(provider).toEqual(
      makeProvider({
        id: "demo",
        label: "Demo Provider",
        aliases: ["alias-one"],
        deprecatedProfileIds: ["demo:legacy"],
        envVars: ["DEMO_API_KEY"],
        auth: [
          {
            id: "primary",
            label: "Primary",
            kind: "custom",
            wizard: {
              choiceId: "demo-primary",
              modelTarget: "utility",
              assistantVisibility: "detected-only",
              onboardingFeatured: true,
              modelAllowlist: {
                allowedKeys: ["demo/model"],
                initialSelections: ["demo/model"],
                loadCatalog: true,
                message: "Demo models",
              },
            },
            run: primaryAuthRun,
          },
        ],
        wizard: {
          setup: {
            choiceId: "demo-choice",
            onboardingFeatured: true,
          },
          modelPicker: {
            label: "Demo models",
          },
        },
      }),
    );
    expect(diagnostics.map(({ level, message }) => ({ level, message }))).toEqual([
      {
        level: "error",
        message: 'provider "demo" auth method duplicated id "primary"',
      },
      {
        level: "error",
        message: 'provider "demo" auth method missing id',
      },
      {
        level: "warn",
        message:
          'provider "demo" setup method "missing" not found; falling back to available methods',
      },
      {
        level: "warn",
        message:
          'provider "demo" model-picker method "missing" not found; falling back to available methods',
      },
    ]);
  });

  it("drops wizard metadata when a provider has no auth methods", () => {
    const { provider, diagnostics } = normalizeProviderFixture(
      makeProvider({
        wizard: {
          setup: {
            choiceId: "demo",
          },
          modelPicker: {
            label: "Demo",
          },
        },
      }),
    );
    expect(provider?.wizard).toBeUndefined();
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'provider "demo" setup metadata ignored because it has no auth methods',
      'provider "demo" model-picker metadata ignored because it has no auth methods',
    ]);
  });
});
