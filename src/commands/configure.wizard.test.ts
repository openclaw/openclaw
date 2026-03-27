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

const EMPTY_CONFIG_SNAPSHOT = {
  exists: false,
  valid: true,
  config: {},
  issues: [],
};

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function createSearchProviderOption(overrides: Record<string, unknown>) {
  return overrides;
}

function createEnabledWebSearchConfig(provider: string, pluginEntry: Record<string, unknown>) {
  return (cfg: OpenClawConfig) => ({
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
        [provider]: pluginEntry,
      },
    },
  });
}

function setupBaseWizardState() {
  mocks.readConfigFileSnapshot.mockResolvedValue(EMPTY_CONFIG_SNAPSHOT);
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.probeGatewayReachable.mockResolvedValue({ ok: false });
  mocks.resolveControlUiLinks.mockReturnValue({ wsUrl: "ws://127.0.0.1:18789" });
  mocks.summarizeExistingConfig.mockReturnValue("");
  mocks.createClackPrompter.mockReturnValue({});
}

function queueWizardPrompts(params: { select: string[]; confirm: boolean[]; text?: string }) {
  const selectQueue = [...params.select];
  const confirmQueue = [...params.confirm];
  mocks.clackSelect.mockImplementation(async () => selectQueue.shift());
  mocks.clackConfirm.mockImplementation(async () => confirmQueue.shift());
  mocks.clackText.mockResolvedValue(params.text ?? "");
  mocks.clackIntro.mockResolvedValue(undefined);
  mocks.clackOutro.mockResolvedValue(undefined);
}

async function runWebConfigureWizard() {
  await runConfigureWizard({ command: "configure", sections: ["web"] }, createRuntime());
}

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
    setupBaseWizardState();
    queueWizardPrompts({
      select: ["local", "__continue"],
      confirm: [false],
    });

    await runConfigureWizard({ command: "configure" }, createRuntime());

    expect(mocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        gateway: expect.objectContaining({ mode: "local" }),
      }),
    );
  });

  it("exits with code 1 when configure wizard is cancelled", async () => {
    const runtime = createRuntime();
    setupBaseWizardState();
    mocks.clackSelect.mockRejectedValueOnce(new WizardCancelledError());

    await runConfigureWizard({ command: "configure" }, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("persists provider-owned web search config changes returned by applySearchKey", async () => {
    setupBaseWizardState();
    mocks.resolveExistingKey.mockReturnValue(undefined);
    mocks.hasExistingKey.mockReturnValue(false);
    mocks.hasKeyInEnv.mockReturnValue(false);
    mocks.applySearchKey.mockImplementation((cfg: OpenClawConfig, provider: string, key: string) =>
      createEnabledWebSearchConfig(provider, {
        enabled: true,
        config: { webSearch: { apiKey: key } },
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local", "firecrawl"],
      confirm: [true, false],
      text: "fc-entered-key",
    });

    await runWebConfigureWizard();

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
    setupBaseWizardState();
    mocks.resolveExistingKey.mockReturnValue(undefined);
    mocks.hasExistingKey.mockReturnValue(true);
    mocks.hasKeyInEnv.mockReturnValue(false);
    mocks.applySearchProviderSelection.mockImplementation((cfg: OpenClawConfig, provider: string) =>
      createEnabledWebSearchConfig(provider, {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local", "firecrawl"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

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
      setupBaseWizardState();
      mocks.resolveSearchProviderOptions.mockReturnValue([
        createSearchProviderOption({
          id: "gemini",
          label: "Gemini (Google Search)",
          hint: "Requires Google Gemini API key · Google Search grounding",
          credentialLabel: "Google Gemini API key",
          envVars: ["GEMINI_API_KEY"],
          placeholder: "AIza...",
          signupUrl: "https://aistudio.google.com/apikey",
          credentialPath: "plugins.entries.google.config.webSearch.apiKey",
        }),
      ]);
      queueWizardPrompts({
        select: ["local", "gemini"],
        confirm: [true, false],
      });

      await runWebConfigureWizard();

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
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({
      select: ["local"],
      confirm: [true, false],
    });

    await expect(runWebConfigureWizard()).resolves.toBeUndefined();

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
    setupBaseWizardState();
    mocks.resolveSearchProviderOptions.mockReturnValue([
      createSearchProviderOption({
        id: "duckduckgo",
        label: "DuckDuckGo Search (experimental)",
        hint: "Free fallback",
        requiresCredential: false,
        envVars: [],
        placeholder: "(no key needed)",
        signupUrl: "https://duckduckgo.com/",
        docsUrl: "https://docs.openclaw.ai/tools/web",
        credentialPath: "",
      }),
    ]);
    mocks.applySearchProviderSelection.mockImplementation((cfg: OpenClawConfig, provider: string) =>
      createEnabledWebSearchConfig(provider, {
        enabled: true,
      })(cfg),
    );
    queueWizardPrompts({
      select: ["local", "duckduckgo"],
      confirm: [true, false],
    });

    await runWebConfigureWizard();

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
