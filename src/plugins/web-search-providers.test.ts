import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginWebSearchProviders } from "./web-search-providers.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

describe("resolvePluginWebSearchProviders", () => {
  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue({
      webSearchProviders: [
        {
          pluginId: "web-search-gemini",
          provider: {
            id: "gemini",
            label: "Gemini",
            hint: "hint",
            envVars: ["GEMINI_API_KEY"],
            placeholder: "AIza...",
            signupUrl: "https://example.com",
            autoDetectOrder: 20,
          },
        },
        {
          pluginId: "web-search-brave",
          provider: {
            id: "brave",
            label: "Brave",
            hint: "hint",
            envVars: ["BRAVE_API_KEY"],
            placeholder: "BSA...",
            signupUrl: "https://example.com",
            autoDetectOrder: 10,
          },
        },
      ],
    });
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginWebSearchProviders({
      workspaceDir: "/workspace/explicit",
      env,
    });

    expect(providers.map((provider) => provider.id)).toEqual(["brave", "gemini"]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/explicit",
        env,
      }),
    );
  });

  it("can augment restrictive allowlists for bundled compatibility", () => {
    resolvePluginWebSearchProviders({
      config: {
        plugins: {
          allow: ["openrouter"],
        },
      },
      bundledAllowlistCompat: true,
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            allow: expect.arrayContaining([
              "openrouter",
              "web-search-brave",
              "web-search-perplexity",
            ]),
          }),
        }),
      }),
    );
  });

  it("auto-enables bundled web search provider plugins when entries are missing", () => {
    resolvePluginWebSearchProviders({
      config: {
        plugins: {
          entries: {
            openrouter: { enabled: true },
          },
        },
      },
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              openrouter: { enabled: true },
              "web-search-brave": { enabled: true },
              "web-search-gemini": { enabled: true },
              "web-search-grok": { enabled: true },
              moonshot: { enabled: true },
              "web-search-perplexity": { enabled: true },
            }),
          }),
        }),
      }),
    );
  });

  it("preserves explicit bundled provider entry state", () => {
    resolvePluginWebSearchProviders({
      config: {
        plugins: {
          entries: {
            "web-search-perplexity": { enabled: false },
          },
        },
      },
    });

    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          plugins: expect.objectContaining({
            entries: expect.objectContaining({
              "web-search-perplexity": { enabled: false },
            }),
          }),
        }),
      }),
    );
  });
});
