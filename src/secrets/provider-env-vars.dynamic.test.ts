import { beforeEach, describe, expect, it, vi } from "vitest";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    providerAuthEnvVars?: Record<string, string[]>;
    providerSecretEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
  }>;
  diagnostics: unknown[];
};

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({ plugins: [], diagnostics: [] })),
);

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

describe("provider env vars dynamic manifest metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
  });

  it("includes later-installed plugin env vars without a bundled generated map", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-fireworks",
          origin: "global",
          providerAuthEnvVars: {
            fireworks: ["FIREWORKS_ALT_API_KEY"],
          },
          providerAuthAliases: {
            "fireworks-plan": "fireworks",
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(mod.getProviderEnvVars("fireworks-plan")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(mod.listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });

  it("keeps secret-only manifest env vars out of auth candidate resolution", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-zai",
          origin: "global",
          providerAuthEnvVars: {
            zai: ["ZAI_API_KEY"],
          },
          providerSecretEnvVars: {
            zai: ["ZAI_API_KEYS"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.resolveProviderAuthEnvVarCandidates().zai).toEqual(["ZAI_API_KEY"]);
    expect(mod.getProviderEnvVars("zai")).toEqual(["ZAI_API_KEY", "ZAI_API_KEYS"]);
    expect(mod.listKnownSecretEnvVarNames()).toContain("ZAI_API_KEYS");
  });

  it("preserves plugin secret env vars for core provider ids", async () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "external-openai",
          origin: "global",
          providerAuthEnvVars: {
            openai: ["OPENAI_ALT_API_KEY"],
          },
          providerSecretEnvVars: {
            openai: ["OPENAI_RESPONSES_KEY"],
          },
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.resolveProviderAuthEnvVarCandidates().openai).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_ALT_API_KEY",
    ]);
    expect(mod.getProviderEnvVars("openai")).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_ALT_API_KEY",
      "OPENAI_RESPONSES_KEY",
    ]);
    expect(mod.listKnownSecretEnvVarNames()).toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "OPENAI_ALT_API_KEY", "OPENAI_RESPONSES_KEY"]),
    );
  });
});
