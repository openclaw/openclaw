import { beforeEach, describe, expect, it, vi } from "vitest";

const loadOpenClawPluginsMock = vi.fn();
const loadPluginManifestRegistryMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

vi.mock("./manifest-registry.js", () => ({
  loadPluginManifestRegistry: (...args: unknown[]) => loadPluginManifestRegistryMock(...args),
}));

let resolveOwningPluginIdsForProvider: typeof import("./providers.js").resolveOwningPluginIdsForProvider;
let resolvePluginProviders: typeof import("./providers.js").resolvePluginProviders;

describe("resolvePluginProviders", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue({
      providers: [{ pluginId: "google", provider: { id: "demo-provider" } }],
    });
    loadPluginManifestRegistryMock.mockReset();
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        { id: "google", providers: ["google"], origin: "bundled" },
        { id: "kilocode", providers: ["kilocode"], origin: "bundled" },
        { id: "moonshot", providers: ["moonshot"], origin: "bundled" },
        { id: "google-gemini-cli-auth", providers: [], origin: "bundled" },
        { id: "workspace-provider", providers: ["workspace-provider"], origin: "workspace" },
      ],
      diagnostics: [],
    });
    ({ resolveOwningPluginIdsForProvider, resolvePluginProviders } =
      await import("./providers.js"));
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginProviders({
      workspaceDir: "/workspace/explicit",
      env,
    });

    expect(providers).toEqual([{ id: "demo-provider", pluginId: "google" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/explicit",
        env,
        cache: false,
        activate: false,
      }),
    );
  });

  it("can augment restrictive allowlists for bundled provider compatibility", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledProviderAllowlistCompat: true,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: expect.arrayContaining(["openrouter", "google", "kilocode", "moonshot"]),
          }),
        }),
        cache: false,
        activate: false,
      }),
    );
  });
  it("can enable bundled provider plugins under Vitest when no explicit plugin config exists", () => {
    resolvePluginProviders({
      env: { VITEST: "1" } as NodeJS.ProcessEnv,
      bundledProviderVitestCompat: true,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            enabled: true,
            allow: expect.arrayContaining(["google", "moonshot"]),
          }),
        }),
        cache: false,
        activate: false,
      }),
    );
  });

  it("does not reintroduce the retired google auth plugin id into compat allowlists", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledProviderAllowlistCompat: true,
    });

    const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
    const allow = call?.config?.plugins?.allow;

    expect(allow).toContain("google");
    expect(allow).not.toContain("google-gemini-cli-auth");
  });

  it("does not inject non-bundled provider plugin ids into compat allowlists", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledProviderAllowlistCompat: true,
    });

    const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
    const allow = call?.config?.plugins?.allow;

    expect(allow).not.toContain("workspace-provider");
  });

  it("scopes bundled provider compat expansion to the requested plugin ids", () => {
    resolvePluginProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledProviderAllowlistCompat: true,
      onlyPluginIds: ["moonshot"],
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["moonshot"],
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: expect.arrayContaining(["openrouter", "moonshot"]),
          }),
        }),
      }),
    );

    const call = loadOpenClawPluginsMock.mock.calls.at(-1)?.[0];
    const allow = call?.config?.plugins?.allow;
    expect(allow).not.toContain("google");
    expect(allow).not.toContain("kilocode");
  });

  it("maps provider ids to owning plugin ids via manifests", () => {
    loadPluginManifestRegistryMock.mockReturnValue({
      plugins: [
        { id: "minimax", providers: ["minimax", "minimax-portal"] },
        { id: "openai", providers: ["openai", "openai-codex"] },
      ],
      diagnostics: [],
    });

    expect(resolveOwningPluginIdsForProvider({ provider: "minimax-portal" })).toEqual(["minimax"]);
    expect(resolveOwningPluginIdsForProvider({ provider: "openai-codex" })).toEqual(["openai"]);
    expect(resolveOwningPluginIdsForProvider({ provider: "gemini-cli" })).toBeUndefined();
  });
});
