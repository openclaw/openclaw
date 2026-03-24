import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  clackIntro: vi.fn(),
  clackOutro: vi.fn(),
  clackSelect: vi.fn(),
  clackText: vi.fn(),
  clackConfirm: vi.fn(),
  applySearchKey: vi.fn(),
  applySearchProviderSelection: vi.fn(),
  hasExistingKey: vi.fn(),
  hasKeyInEnv: vi.fn(),
  resolveExistingKey: vi.fn(),
  resolveSearchProviderOptions: vi.fn(),
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

vi.mock("./onboard-search.js", () => ({
  resolveSearchProviderOptions: mocks.resolveSearchProviderOptions,
  SEARCH_PROVIDER_OPTIONS: [
    {
      id: "firecrawl",
      label: "Firecrawl Search",
      hint: "Structured results with optional result scraping",
      credentialLabel: "Firecrawl API key",
      envVars: ["FIRECRAWL_API_KEY"],
      placeholder: "fc-...",
      signupUrl: "https://www.firecrawl.dev/",
      credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
    },
  ],
  resolveExistingKey: mocks.resolveExistingKey,
  hasExistingKey: mocks.hasExistingKey,
  applySearchKey: mocks.applySearchKey,
  applySearchProviderSelection: mocks.applySearchProviderSelection,
  hasKeyInEnv: mocks.hasKeyInEnv,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { runConfigureWizard } from "./configure.wizard.js";

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureControlUiAssetsBuilt.mockResolvedValue({ ok: true });
    mocks.resolveExistingKey.mockReturnValue(undefined);
    mocks.hasExistingKey.mockReturnValue(false);
    mocks.hasKeyInEnv.mockReturnValue(false);
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "firecrawl",
        label: "Firecrawl Search",
        hint: "Structured results with optional result scraping",
        credentialLabel: "Firecrawl API key",
        envVars: ["FIRECRAWL_API_KEY"],
        placeholder: "fc-...",
        signupUrl: "https://www.firecrawl.dev/",
        credentialPath: "plugins.entries.firecrawl.config.webSearch.apiKey",
      },
    ]);
    mocks.applySearchKey.mockReset();
    mocks.applySearchProviderSelection.mockReset();
    mocks.applySearchProviderSelection.mockImplementation((cfg: OpenClawConfig) => cfg);
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

  it("persists provider-owned web search config changes returned by applySearchKey", async () => {
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
    mocks.resolveExistingKey.mockReturnValue(undefined);
    mocks.hasExistingKey.mockReturnValue(false);
    mocks.hasKeyInEnv.mockReturnValue(false);
    mocks.applySearchKey.mockImplementation(
      (cfg: OpenClawConfig, provider: string, key: string) => ({
        ...cfg,
        tools: {
          ...cfg.tools,
          web: {
            ...cfg.tools?.web,
            search: {
              provider,
              enabled: true,
            },
          },
        },
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            firecrawl: {
              enabled: true,
              config: { webSearch: { apiKey: key } },
            },
          },
        },
      }),
    );

    const selectQueue = ["local", "firecrawl"];
    const confirmQueue = [true, false];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
    mocks.clackText.mockResolvedValue("fc-entered-key");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);

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
              provider: "firecrawl",
              enabled: true,
            }),
          }),
        }),
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              enabled: true,
              config: expect.objectContaining({
                webSearch: expect.objectContaining({ apiKey: "fc-entered-key" }),
              }),
            }),
          }),
        }),
      }),
    );
    expect(mocks.clackText).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Firecrawl API key (paste it here; leave blank to use FIRECRAWL_API_KEY)",
      }),
    );
  });

  it("applies provider selection side effects when a key already exists via secret ref or env", async () => {
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
    mocks.resolveExistingKey.mockReturnValue(undefined);
    mocks.hasExistingKey.mockReturnValue(true);
    mocks.hasKeyInEnv.mockReturnValue(false);
    mocks.applySearchProviderSelection.mockImplementation(
      (cfg: OpenClawConfig, provider: string) => ({
        ...cfg,
        tools: {
          ...cfg.tools,
          web: {
            ...cfg.tools?.web,
            search: {
              provider,
              enabled: true,
            },
          },
        },
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            firecrawl: {
              enabled: true,
            },
          },
        },
      }),
    );

    const selectQueue = ["local", "firecrawl"];
    const confirmQueue = [true, false];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
    mocks.clackText.mockResolvedValue("");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.applySearchProviderSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
      "firecrawl",
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            firecrawl: expect.objectContaining({
              enabled: true,
            }),
          }),
        }),
      }),
    );
    expect(mocks.clackText).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Firecrawl API key (leave blank to keep current or use FIRECRAWL_API_KEY)",
      }),
    );
  });

  it("uses provider-specific credential copy for Gemini web search", async () => {
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
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
      mocks.resolveSearchProviderOptions.mockReturnValue([
        {
          id: "gemini",
          label: "Gemini (Google Search)",
          hint: "Requires Google Gemini API key · Google Search grounding",
          credentialLabel: "Google Gemini API key",
          envVars: ["GEMINI_API_KEY"],
          placeholder: "AIza...",
          signupUrl: "https://aistudio.google.com/apikey",
          credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        },
      ]);

      const selectQueue = ["local", "gemini"];
      const confirmQueue = [true, false];
      mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
      mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
      mocks.clackText.mockResolvedValue("");
      mocks.clackIntro.mockResolvedValue(undefined);
      mocks.clackOutro.mockResolvedValue(undefined);

      await runConfigureWizard(
        { command: "configure", sections: ["web"] },
        {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        },
      );

      expect(mocks.clackText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("Google Gemini API key"),
        }),
      );
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Store your Google Gemini API key here or set GEMINI_API_KEY"),
        "Web search",
      );
    } finally {
      if (originalGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = originalGeminiApiKey;
      }
    }
  });

  it("does not crash when web search providers are unavailable under plugin policy", async () => {
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
    mocks.resolveSearchProviderOptions.mockReturnValue([]);

    const selectQueue = ["local"];
    const confirmQueue = [true, false];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
    mocks.clackText.mockResolvedValue("");
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);

    await expect(
      runConfigureWizard(
        { command: "configure", sections: ["web"] },
        {
          log: vi.fn(),
          error: vi.fn(),
          exit: vi.fn(),
        },
      ),
    ).resolves.toBeUndefined();

    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "No web search providers are currently available under this plugin policy.",
      ),
      "Web search",
    );
    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({
          web: expect.objectContaining({
            search: expect.objectContaining({
              enabled: false,
            }),
          }),
        }),
      }),
    );
  });

  it("skips the API key prompt for keyless web search providers", async () => {
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
    mocks.resolveSearchProviderOptions.mockReturnValue([
      {
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        credentialPath: "",
      },
    ]);
    mocks.applySearchProviderSelection.mockImplementation(
      (cfg: OpenClawConfig, provider: string) => ({
        ...cfg,
        tools: {
          ...cfg.tools,
          web: {
            ...cfg.tools?.web,
            search: {
              provider,
              enabled: true,
            },
          },
        },
        plugins: {
          ...cfg.plugins,
          entries: {
            ...cfg.plugins?.entries,
            duckduckgo: {
              enabled: true,
            },
          },
        },
      }),
    );

    const selectQueue = ["local", "duckduckgo"];
    const confirmQueue = [true, false];
    mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
    mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
    mocks.clackIntro.mockResolvedValue(undefined);
    mocks.clackOutro.mockResolvedValue(undefined);

    await runConfigureWizard(
      { command: "configure", sections: ["web"] },
      {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
    );

    expect(mocks.clackText).not.toHaveBeenCalled();
    expect(mocks.applySearchProviderSelection).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
      "duckduckgo",
    );
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("works without an API key"),
      "Web search",
    );
  });
});
