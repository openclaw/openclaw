import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  clackIntro: vi.fn(),
  clackOutro: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clackConfirm: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  writeConfigFile: vi.fn(),
  resolveGatewayPort: vi.fn(),
  ensureControlUiAssetsBuilt: vi.fn(),
  createClackPrompter: vi.fn(),
  note: vi.fn(),
  printWizardHeader: vi.fn(),
  probeGatewayReachable: vi.fn(),
  waitForGatewayReachable: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  summarizeExistingConfig: vi.fn(),
}));

const loadOpenClawPlugins = vi.hoisted(() =>
  vi.fn(() => ({ searchProviders: [] as unknown[], plugins: [] as unknown[] })),
);
const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn(() => ({ plugins: [] as unknown[], diagnostics: [] as unknown[] })),
);
const ensureOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg, installed: false })),
);
const ensureGenericOnboardingPluginInstalled = vi.hoisted(() =>
  vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({ cfg, installed: false })),
);
const reloadOnboardingPluginRegistry = vi.hoisted(() => vi.fn());

vi.mock("@clack/prompts", () => ({
  intro: mocks.clackIntro,
  outro: mocks.clackOutro,
  select: mocks.clackSelect,
  text: mocks.clackText,
  confirm: mocks.clackConfirm,
}));

vi.mock("../config/config.js", () => ({
  CONFIG_PATH: "~/.openclaw/openclaw.json",
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  writeConfigFile: mocks.writeConfigFile,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../infra/control-ui-assets.js", () => ({
  ensureControlUiAssetsBuilt: mocks.ensureControlUiAssetsBuilt,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins,
}));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

vi.mock("./onboarding/plugin-install.js", () => ({
  ensureGenericOnboardingPluginInstalled,
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
}));

vi.mock("../terminal/note.js", () => ({
  note: mocks.note,
}));

vi.mock("./onboard-helpers.js", () => ({
  DEFAULT_WORKSPACE: "~/.openclaw/workspace",
  applyWizardMetadata: (cfg: OpenClawConfig) => cfg,
  ensureWorkspaceAndSessions: vi.fn(),
  guardCancel: <T>(value: T) => value,
  printWizardHeader: mocks.printWizardHeader,
  probeGatewayReachable: mocks.probeGatewayReachable,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  summarizeExistingConfig: mocks.summarizeExistingConfig,
  waitForGatewayReachable: mocks.waitForGatewayReachable,
}));

vi.mock("./health.js", () => ({
  healthCommand: vi.fn(),
}));

vi.mock("./health-format.js", () => ({
  formatHealthCheckFailure: vi.fn(),
}));

vi.mock("./configure.gateway.js", () => ({
  promptGatewayConfig: vi.fn(),
}));

vi.mock("./configure.gateway-auth.js", () => ({
  promptAuthConfig: vi.fn(),
}));

vi.mock("./configure.channels.js", () => ({
  removeChannelConfigWizard: vi.fn(),
}));

vi.mock("./configure.daemon.js", () => ({
  maybeInstallDaemon: vi.fn(),
}));

vi.mock("./onboard-remote.js", () => ({
  promptRemoteGatewayConfig: vi.fn(),
}));

vi.mock("./onboard-skills.js", () => ({
  setupSkills: vi.fn(),
}));

vi.mock("./onboard-channels.js", () => ({
  setupChannels: vi.fn(),
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { runConfigureWizard } from "./configure.wizard.js";

describe("runConfigureWizard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv("BRAVE_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("XAI_API_KEY", "");
    vi.stubEnv("MOONSHOT_API_KEY", "");
    vi.stubEnv("PERPLEXITY_API_KEY", "");
    mocks.clackIntro.mockReset();
    mocks.clackOutro.mockReset();
    mocks.clackSelect.mockReset();
    mocks.clackText.mockReset();
    mocks.clackConfirm.mockReset();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.writeConfigFile.mockReset();
    mocks.resolveGatewayPort.mockReset();
    mocks.ensureControlUiAssetsBuilt.mockReset();
    mocks.createClackPrompter.mockReset();
    mocks.note.mockReset();
    mocks.printWizardHeader.mockReset();
    mocks.probeGatewayReachable.mockReset();
    mocks.waitForGatewayReachable.mockReset();
    mocks.resolveControlUiLinks.mockReset();
    mocks.summarizeExistingConfig.mockReset();
    loadOpenClawPlugins.mockReset();
    loadOpenClawPlugins.mockReturnValue({ searchProviders: [], plugins: [] });
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue({ plugins: [], diagnostics: [] });
    ensureOnboardingPluginInstalled.mockReset();
    ensureOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        installed: false,
      }),
    );
    ensureGenericOnboardingPluginInstalled.mockReset();
    ensureGenericOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg,
        installed: false,
      }),
    );
    reloadOnboardingPluginRegistry.mockReset();
  });

  it("configures a plugin web search provider from the picker", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey", "searchDepth"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            properties: {
              apiKey: { type: "string" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/configure-workspace-search",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.clackSelect.mockImplementation(async (params: { message: string }) => {
      if (params.message === "Choose web search provider") {
        return "tavily";
      }
      if (params.message.startsWith("Search depth")) {
        return "advanced";
      }
      return "__continue";
    });
    mocks.clackText.mockResolvedValue("tvly-test-key");

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              provider: "tavily",
            }),
          }),
        }),
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            "tavily-search": expect.objectContaining({
              enabled: true,
              config: {
                apiKey: "tvly-test-key",
                searchDepth: "advanced",
              },
            }),
          }),
        }),
      }),
    );
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/tmp/configure-workspace-search",
      }),
    );
  });

  it("persists enabling web_search when configuring a provider from a previously disabled state", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/configure-workspace-enable-search",
          },
        },
        tools: {
          web: {
            search: {
              enabled: false,
              provider: "brave",
            },
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    mocks.clackSelect.mockImplementation(async (params: { message: string }) => {
      if (params.message === "Choose web search provider") {
        return "brave";
      }
      return "__continue";
    });

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: true,
              provider: "brave",
            }),
          }),
        }),
      }),
    );
    expect(mocks.writeConfigFile.mock.calls[0]?.[0]?.tools?.web?.search?.provider).toBe("brave");
  });

  it("re-prompts invalid plugin config values during configure", async () => {
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            configFieldOrder: ["apiKey", "searchDepth"],
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/configure-workspace-search",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.clackSelect.mockImplementation(async (params: { message: string }) => {
      if (params.message === "Choose web search provider") {
        return "tavily";
      }
      if (params.message.startsWith("Search depth")) {
        return "advanced";
      }
      return "__continue";
    });
    mocks.clackText.mockResolvedValueOnce("bad-key").mockResolvedValueOnce("tvly-test-key");

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(
      mocks.note.mock.calls.some(
        ([message, title]) =>
          title === "Invalid plugin config" &&
          typeof message === "string" &&
          message.includes("Api Key"),
      ),
    ).toBe(true);
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            "tavily-search": expect.objectContaining({
              config: {
                apiKey: "tvly-test-key",
                searchDepth: "advanced",
              },
            }),
          }),
        }),
      }),
    );
  });

  it("configures a bundled plugin search provider from configure without the external install step", async () => {
    loadOpenClawPlugins.mockImplementation(({ config }: { config: OpenClawConfig }) => {
      const enabled = config.plugins?.entries?.["tavily-search"]?.enabled === true;
      return enabled
        ? {
            searchProviders: [
              {
                pluginId: "tavily-search",
                provider: {
                  id: "tavily",
                  name: "Tavily Search",
                  description: "Plugin search",
                  configFieldOrder: ["apiKey", "searchDepth"],
                  search: async () => ({ content: "ok" }),
                },
              },
            ],
            plugins: [
              {
                id: "tavily-search",
                name: "Tavily Search",
                description: "External Tavily plugin",
                origin: "workspace",
                source: "/tmp/tavily-search",
                configJsonSchema: {
                  type: "object",
                  properties: {
                    apiKey: { type: "string" },
                    searchDepth: { type: "string", enum: ["basic", "advanced"] },
                  },
                },
                configUiHints: {
                  apiKey: {
                    label: "Tavily API key",
                    placeholder: "tvly-...",
                    sensitive: true,
                  },
                  searchDepth: {
                    label: "Search depth",
                  },
                },
              },
            ],
          }
        : { searchProviders: [], plugins: [] };
    });
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "Search the web using Tavily.",
          provides: ["providers.search.tavily"],
          origin: "bundled",
          source: "/tmp/bundled/tavily-search",
          configSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", minLength: 1, pattern: "^tvly-\\S+$" },
              searchDepth: { type: "string", enum: ["basic", "advanced"] },
            },
          },
          configUiHints: {
            apiKey: {
              label: "Tavily API key",
              placeholder: "tvly-...",
              sensitive: true,
            },
            searchDepth: {
              label: "Search depth",
            },
          },
        },
      ],
      diagnostics: [],
    });
    ensureOnboardingPluginInstalled.mockImplementation(
      async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: {
          ...cfg,
          plugins: {
            ...cfg.plugins,
            entries: {
              ...cfg.plugins?.entries,
              "tavily-search": {
                ...(cfg.plugins?.entries?.["tavily-search"] as Record<string, unknown> | undefined),
                enabled: true,
              },
            },
          },
        },
        installed: true,
      }),
    );
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        agents: {
          defaults: {
            workspace: "/tmp/configure-install-workspace",
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.clackSelect.mockImplementation(async (params: { message: string }) => {
      if (params.message === "Choose web search provider") {
        return "tavily";
      }
      if (params.message.startsWith("Search depth")) {
        return "advanced";
      }
      return "__continue";
    });
    mocks.clackText.mockResolvedValue("tvly-installed-key");

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(ensureOnboardingPluginInstalled).not.toHaveBeenCalled();
    expect(reloadOnboardingPluginRegistry).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              provider: "tavily",
              enabled: true,
            }),
          }),
        }),
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            "tavily-search": expect.objectContaining({
              enabled: true,
              config: {
                apiKey: "tvly-installed-key",
                searchDepth: "advanced",
              },
            }),
          }),
        }),
      }),
    );
  });

  it("persists gateway.mode=local when only the run mode is selected", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});

    const selectQueue = ["local", "__continue"];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackText.mockResolvedValue("");
    mocks.clackConfirm.mockResolvedValue(false);

    await runConfigureWizard(
      { command: "configure" },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: false,
      valid: true,
      config: {},
      issues: [],
    });
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves an existing plugin web search provider when keeping the current provider", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        tools: {
          web: {
            search: {
              provider: "searxng",
              enabled: true,
            },
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm
      .mockResolvedValueOnce(true) // enable web_search
      .mockResolvedValueOnce(true); // enable web_fetch
    mocks.clackSelect.mockResolvedValue("__keep_current__");
    mocks.clackText.mockResolvedValue("");

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              provider: "searxng",
              enabled: true,
            }),
          }),
        }),
      }),
    );
  });

  it("shows the active provider first when multiple providers are configured", async () => {
    vi.stubEnv("BRAVE_API_KEY", "BSA-test-key");
    loadOpenClawPlugins.mockReturnValue({
      searchProviders: [
        {
          pluginId: "tavily-search",
          provider: {
            id: "tavily",
            name: "Tavily Search",
            description: "Plugin search",
            isAvailable: () => true,
            search: async () => ({ content: "ok" }),
          },
        },
      ],
      plugins: [
        {
          id: "tavily-search",
          name: "Tavily Search",
          description: "External Tavily plugin",
          origin: "workspace",
          source: "/tmp/tavily-search",
          configJsonSchema: undefined,
          configUiHints: undefined,
        },
      ],
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: {
        tools: {
          web: {
            search: {
              provider: "tavily",
              enabled: true,
            },
          },
        },
      },
      issues: [],
    });
    mocks.resolveGatewayPort.mockReturnValue(18789);
    mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
    mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
    mocks.summarizeExistingConfig.mockReturnValue("");
    mocks.createClackPrompter.mockReturnValue({});
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);
    mocks.clackConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    mocks.clackSelect.mockImplementation(
      async (params: { message: string; options?: Array<{ value: string; hint?: string }> }) => {
        if (params.message === "Choose web search provider") {
          expect(params.options?.[0]).toMatchObject({
            value: "tavily",
            hint: "Plugin search · External plugin",
          });
          expect(params.options?.[1]).toMatchObject({
            value: "__install_plugin__",
            hint: "Add an external web search plugin",
          });
          return "tavily";
        }
        return "__continue";
      },
    );
    mocks.clackText.mockResolvedValue("");

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );
  });
});
