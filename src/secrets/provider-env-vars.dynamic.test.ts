import { beforeEach, describe, expect, it, vi } from "vitest";

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    providerAuthEnvVars?: Record<string, string[]>;
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
        },
      ],
      diagnostics: [],
    });

    const mod = await import("./provider-env-vars.js");

    expect(mod.getProviderEnvVars("fireworks")).toEqual(["FIREWORKS_ALT_API_KEY"]);
    expect(mod.listKnownProviderAuthEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
    expect(mod.listKnownSecretEnvVarNames()).toContain("FIREWORKS_ALT_API_KEY");
  });
});
