import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginProviders } from "./providers.js";

const loadOpenClawPluginsMock = vi.fn();

vi.mock("./loader.js", () => ({
  loadOpenClawPlugins: (...args: unknown[]) => loadOpenClawPluginsMock(...args),
}));

describe("resolvePluginProviders", () => {
  beforeEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue({
      providers: [{ provider: { id: "demo-provider" } }],
    });
  });

  it("forwards an explicit env to plugin loading", () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    const providers = resolvePluginProviders({
      workspaceDir: "/workspace/explicit",
      env,
    });

    expect(providers).toEqual([{ id: "demo-provider" }]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/workspace/explicit",
        env,
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
            allow: expect.arrayContaining(["openrouter", "kilocode", "moonshot"]),
          }),
        }),
      }),
    );
  });
});
