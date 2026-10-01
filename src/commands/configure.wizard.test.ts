import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatCliCommand } from "../cli/command-format.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { committedConfigFiles } from "./committed-config.test-support.js";
import {
  createEnabledWebSearchConfig,
  createWizardTestRuntime as createRuntime,
  EMPTY_CONFIG_SNAPSHOT,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";

const { configureCommandFromSectionsArg } = await import("./configure.commands.js");

const written = () => mocks.writeConfigFile.mock.calls.at(-1)![0];
const configureWeb = () =>
  runConfigureWizard({ command: "configure", sections: ["web"] }, createRuntime());
const nativeSearchConfig: OpenClawConfig = {
  auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
};

function agentConfig(config: OpenClawConfig) {
  setupBaseWizardState(config);
  mocks.readConfigFileSnapshot.mockResolvedValue({
    ...EMPTY_CONFIG_SNAPSHOT,
    exists: true,
    config,
    sourceConfig: config,
  });
  queueWizardPrompts({ select: ["configure"], confirm: [], text: "/tmp/new-workspace" });
}

function expectWorkspaceSetup(workspaceDir: string, agentId: string) {
  expect(mocks.setupPluginConfig).toHaveBeenCalledWith(expect.objectContaining({ workspaceDir }));
  expect(mocks.setupSkills).toHaveBeenCalledWith(
    expect.any(Object),
    workspaceDir,
    expect.any(Object),
    expect.any(Object),
  );
  expect(mocks.ensureWorkspaceAndSessions).toHaveBeenCalledWith(
    workspaceDir,
    expect.any(Object),
    expect.objectContaining({ agentId }),
  );
}

describe("runConfigureWizard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    setupWizardTestDefaults();
    setupBaseWizardState();
  });

  it("directs invalid config to Doctor before making changes", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      ...EMPTY_CONFIG_SNAPSHOT,
      exists: true,
      valid: false,
      issues: [{ path: "browser.actionTimeoutTypoMs", message: "Unknown key" }],
    });
    const runtime = createRuntime();
    await runConfigureWizard({ command: "configure" }, runtime);
    expect(mocks.clackOutro).toHaveBeenCalledWith(
      "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run configure.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.clackSelect).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("persists provider-owned search and fetch settings", async () => {
    mocks.setupSearch.mockImplementation(async (cfg: OpenClawConfig) => {
      const config = createEnabledWebSearchConfig("firecrawl", {
        enabled: true,
        config: { webSearch: { apiKey: "fc-entered-key" } },
      })(cfg);
      return {
        outcome: "completed",
        config: {
          ...config,
          tools: {
            ...config.tools,
            web: { ...config.tools.web, fetch: { provider: "firecrawl" } },
          },
        },
      };
    });
    queueWizardPrompts({ select: [], confirm: [true, true] });
    await configureWeb();
    expect(written().tools?.web).toMatchObject({
      search: { provider: "firecrawl", enabled: true },
      fetch: { provider: "firecrawl", enabled: true },
    });
    expect(written().plugins?.entries?.firecrawl).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "fc-entered-key" } },
    });
    expect(mocks.setupSearch).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ gateway: expect.anything() }),
      expect.anything(),
      expect.anything(),
      { preserveDisabledSearchState: false },
    );
  });

  it("disables search when plugin policy leaves no available provider", async () => {
    mocks.resolveSearchProviderOptions.mockReturnValue([]);
    queueWizardPrompts({ select: [], confirm: [true, false] });
    await configureWeb();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("No web search providers are currently available"),
      "Web search",
    );
    expect(written().tools?.web?.search?.enabled).toBe(false);
  });

  it("disables managed search without loading providers or selecting an agent", async () => {
    setupBaseWizardState({ agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } });
    queueWizardPrompts({ select: [], confirm: [false, true] });
    await configureWeb();
    expect(mocks.clackSelect).not.toHaveBeenCalled();
    expect(mocks.resolveSearchProviderOptions).not.toHaveBeenCalled();
    expect(mocks.setupSearch).not.toHaveBeenCalled();
    expect(written().tools?.web?.search?.enabled).toBe(false);
  });

  it("enables native search without a managed provider", async () => {
    setupBaseWizardState(nativeSearchConfig);
    queueWizardPrompts({ select: ["cached"], confirm: [true, true, false, true] });
    await configureWeb();
    expect(written().tools?.web).toMatchObject({
      search: { enabled: true, openaiCodex: { enabled: true, mode: "cached" } },
      fetch: { enabled: true },
    });
    expect(mocks.setupSearch).not.toHaveBeenCalled();
  });

  it("preserves the native search mode when disabling it", async () => {
    setupBaseWizardState({
      ...nativeSearchConfig,
      tools: { web: { search: { enabled: true, openaiCodex: { enabled: true, mode: "live" } } } },
    });
    queueWizardPrompts({ select: ["firecrawl"], confirm: [true, false, true, false] });
    await configureWeb();
    expect(written().tools?.web?.search).toMatchObject({
      enabled: true,
      openaiCodex: { enabled: false, mode: "live" },
    });
    expect(mocks.setupSearch).toHaveBeenCalledOnce();
  });

  it("preserves concurrent nested plugin writes on conflict (#64188)", async () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: { "github-copilot": { enabled: false, config: { region: "us-east-1" } } },
      },
    };
    const updated: OpenClawConfig = {
      plugins: {
        entries: {
          "github-copilot": {
            enabled: false,
            config: { region: "us-east-1", accessToken: "plugin-wrote-this" },
          },
        },
      },
    };
    queueWizardPrompts({ select: [], confirm: [] });
    const snapshot = (source: OpenClawConfig, hash: string) => ({
      ...EMPTY_CONFIG_SNAPSHOT,
      config: source,
      sourceConfig: source,
      hash,
    });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(snapshot(config, "before"))
      .mockResolvedValueOnce(snapshot(config, "before"))
      .mockResolvedValueOnce(snapshot(updated, "after"));
    mocks.replaceConfigFile
      .mockImplementationOnce(async ({ baseHash }) => {
        expect(baseHash).toBe("before");
        throw new ConfigMutationConflictError("config changed since last load");
      })
      .mockImplementationOnce(async ({ nextConfig, baseHash }) => {
        expect(baseHash).toBe("after");
        await mocks.writeConfigFile(nextConfig);
        return committedConfigFiles.write(nextConfig);
      });
    await runConfigureWizard({ command: "configure", sections: ["workspace"] }, createRuntime());
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(3);
    expect(written().agents?.defaults?.workspace).toContain("/.openclaw/workspace");
    expect(written().plugins).toEqual(updated.plugins);
  });

  it("does not retry after config path ownership changes", async () => {
    queueWizardPrompts({ select: [], confirm: [] });
    mocks.assertConfigPathForWrite.mockImplementation(() => {
      throw new ConfigMutationConflictError("config path changed since last load", {
        retryable: false,
      });
    });
    await expect(
      runConfigureWizard({ command: "configure", sections: ["workspace"] }, createRuntime()),
    ).rejects.toThrow("config path changed since last load");
    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledTimes(2);
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("uses one selected agent through setup and commits before channel hooks", async () => {
    agentConfig({
      agents: {
        ownership: "explicit",
        defaults: { workspace: "/tmp/global" },
        entries: { alpha: { workspace: "/tmp/alpha" }, beta: {} },
      },
    });
    queueWizardPrompts({ select: ["beta", "configure"], confirm: [], text: "/tmp/new-workspace" });
    const hook = vi.fn(async () => {});
    mocks.setupChannels.mockImplementationOnce(async (config, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({ channel: "matrix", accountId: "beta", run: hook });
      return config;
    });
    await runConfigureWizard(
      { command: "configure", sections: ["workspace", "plugins", "skills", "channels"] },
      createRuntime(),
    );
    expect(written().agents).toEqual({
      ownership: "explicit",
      defaults: { workspace: "/tmp/global" },
      entries: { alpha: { workspace: "/tmp/alpha" }, beta: { workspace: "/tmp/new-workspace" } },
    });
    expectWorkspaceSetup("/tmp/new-workspace", "beta");
    expect(mocks.setupChannels).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        workspaceDir: "/tmp/new-workspace",
        deferStatusUntilSelection: true,
        skipStatusNote: true,
      }),
    );
    expect(
      mocks.clackSelect.mock.calls.filter(
        ([params]) => params.message === "Which agent do you want to configure?",
      ),
    ).toHaveLength(1);
    expect(hook).toHaveBeenCalledOnce();
    expect(mocks.writeConfigFile.mock.invocationCallOrder[0]!).toBeLessThan(
      hook.mock.invocationCallOrder[0]!,
    );
  });

  it("does not persist an unprovisionable workspace", async () => {
    agentConfig({ agents: { entries: { ops: { workspace: "/tmp/ops" } } } });
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));
    await expect(
      runConfigureWizard(
        { command: "configure", sections: ["workspace", "plugins", "skills"] },
        createRuntime(),
      ),
    ).rejects.toThrow("workspace is unwritable");
    expect(mocks.setupPluginConfig).not.toHaveBeenCalled();
    expect(mocks.setupSkills).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("removes channel config without selecting an agent", async () => {
    const config: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    };
    agentConfig(config);
    mocks.clackSelect.mockResolvedValueOnce("remove");
    await runConfigureWizard({ command: "configure", sections: ["channels"] }, createRuntime());
    expect(mocks.setupChannels).not.toHaveBeenCalled();
    expect(mocks.clackSelect).toHaveBeenCalledOnce();
    expect(written()).toEqual(config);
  });
  it("rejects non-interactive configure before prompting (#93953)", async () => {
    const runtime = createRuntime();
    await configureCommandFromSectionsArg(undefined, runtime, { interactive: false });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledOnce();
    const message = runtime.error.mock.calls[0]?.[0];
    expect(message).toContain("requires an interactive terminal (TTY)");
    expect(message).toContain(formatCliCommand("openclaw config set"));
    expect(message).toContain(formatCliCommand("openclaw config validate"));
    expect(mocks.clackIntro).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("opens the full wizard for Commander's empty section list", async () => {
    queueWizardPrompts({ select: ["local", "__continue"], confirm: [] });
    await configureCommandFromSectionsArg([], createRuntime(), { interactive: true });
    expect(written().gateway?.mode).toBe("local");
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it("dispatches trimmed section names through the wizard", async () => {
    queueWizardPrompts({ select: ["configure"], confirm: [] });
    await configureCommandFromSectionsArg(["  channels  ", "\tplugins\t"], createRuntime(), {
      interactive: true,
    });
    expect(mocks.setupChannels).toHaveBeenCalledOnce();
    expect(mocks.setupPluginConfig).toHaveBeenCalledOnce();
    expect(mocks.promptGatewayConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it.each([
    ["  ", '""'],
    ["bogus", "bogus"],
  ])("rejects section %j before the terminal guard", async (section, diagnostic) => {
    const runtime = createRuntime();
    await configureCommandFromSectionsArg(["channels", section], runtime, { interactive: false });
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(`Invalid --section: ${diagnostic}`),
    );
    expect(mocks.clackIntro).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });
});
