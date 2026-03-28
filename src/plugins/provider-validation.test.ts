import { describe, expect, it } from "vitest";
import { normalizeRegisteredProvider } from "./provider-validation.js";
import type { PluginDiagnostic, ProviderPlugin } from "./types.js";

function collectDiagnostics() {
  const diagnostics: PluginDiagnostic[] = [];
  return {
    diagnostics,
    pushDiagnostic: (diag: PluginDiagnostic) => {
      diagnostics.push(diag);
    },
  };
}

function makeProvider(overrides: Partial<ProviderPlugin>): ProviderPlugin {
  return {
    id: "demo",
    label: "Demo",
    auth: [],
    ...overrides,
  };
}

function expectDiagnosticMessages(
  diagnostics: PluginDiagnostic[],
  expectedDiagnostics: ReadonlyArray<{ level: PluginDiagnostic["level"]; message: string }>,
) {
  expect(diagnostics.map((diag) => ({ level: diag.level, message: diag.message }))).toEqual(
    expectedDiagnostics,
  );
}

function normalizeProviderFixture(provider: ProviderPlugin) {
  const { diagnostics, pushDiagnostic } = collectDiagnostics();
  const normalizedProvider = normalizeRegisteredProvider({
    pluginId: "demo-plugin",
    source: "/tmp/demo/index.ts",
    provider,
    pushDiagnostic,
  });
  return {
    diagnostics,
    provider: normalizedProvider,
  };
}

describe("normalizeRegisteredProvider", () => {
  it.each([
    {
      name: "drops invalid and duplicate auth methods, and clears bad wizard method bindings",
      provider: makeProvider({
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
              modelAllowlist: {
                allowedKeys: [" demo/model ", "demo/model"],
                initialSelections: [" demo/model "],
                message: " Demo models ",
              },
            },
            run: async () => ({ profiles: [] }),
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
            methodId: " missing ",
          },
          modelPicker: {
            label: " Demo models ",
            methodId: " missing ",
          },
        },
      }),
      expectedProvider: {
        id: "demo",
        label: "Demo Provider",
        aliases: ["alias-one"],
        deprecatedProfileIds: ["demo:legacy"],
        envVars: ["DEMO_API_KEY"],
        auth: [
          {
            id: "primary",
            label: "Primary",
            wizard: {
              choiceId: "demo-primary",
              modelAllowlist: {
                allowedKeys: ["demo/model"],
                initialSelections: ["demo/model"],
                message: "Demo models",
              },
            },
          },
        ],
        wizard: {
          setup: {
            choiceId: "demo-choice",
          },
          modelPicker: {
            label: "Demo models",
          },
        },
      },
      expectedDiagnostics: [
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
      ],
    },
    {
      name: "drops wizard metadata when a provider has no auth methods",
      provider: makeProvider({
        wizard: {
          setup: {
            choiceId: "demo",
          },
          modelPicker: {
            label: "Demo",
          },
        },
      }),
      assert: (
        provider: ReturnType<typeof normalizeRegisteredProvider>,
        diagnostics: PluginDiagnostic[],
      ) => {
        expect(provider?.wizard).toBeUndefined();
        expect(diagnostics.map((diag) => diag.message)).toEqual([
          'provider "demo" setup metadata ignored because it has no auth methods',
          'provider "demo" model-picker metadata ignored because it has no auth methods',
        ]);
      },
    },
  ] as const)(
    "$name",
    ({ provider: inputProvider, expectedProvider, expectedDiagnostics, assert }) => {
      const { diagnostics, provider } = normalizeProviderFixture(inputProvider);

      if (assert) {
        assert(provider, diagnostics);
        return;
      }

      expect(provider).toMatchObject(expectedProvider);
      expectDiagnosticMessages(diagnostics, expectedDiagnostics);
    },
  );

  it("prefers catalog when a provider registers both catalog and discovery", () => {
    const { diagnostics, provider } = normalizeProviderFixture(
      makeProvider({
        catalog: {
          run: async () => null,
        },
        discovery: {
          run: async () => ({
            provider: {
              baseUrl: "http://127.0.0.1:8000/v1",
              models: [],
            },
          }),
        },
      }),
    );

    expect(provider?.catalog).toBeDefined();
    expect(provider?.discovery).toBeUndefined();
    expect(diagnostics.map((diag) => diag.message)).toEqual([
      'provider "demo" registered both catalog and discovery; using catalog',
    ]);
  });
});
