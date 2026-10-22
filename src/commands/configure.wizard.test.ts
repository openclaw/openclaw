import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ConfigMutationConflictError } from "../config/mutate.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { committedConfigFiles } from "./committed-config.test-support.js";
import {
  EMPTY_CONFIG_SNAPSHOT,
  queueWizardTestPrompts as queueWizardPrompts,
  runConfigureWizard,
  setupWizardTestDefaults,
  setupBaseWizardTestState as setupBaseWizardState,
  wizardTestMocks as mocks,
} from "./configure.wizard.test-support.js";

const modelSetup = vi.hoisted(() => ({
  authChoice: vi.fn(),
  defaultModel: vi.fn(),
  allowlist: vi.fn(),
}));

// mock-isolation: The operator's auth choice comes from the test, not an interactive picker.
vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped: modelSetup.authChoice }));

// mock-isolation: The operator's model choice comes from the test without loading catalogs.
vi.mock("../flows/model-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/model-picker.js")>()),
  promptDefaultModel: modelSetup.defaultModel,
  promptModelAllowlist: modelSetup.allowlist,
}));

const { configureCommandFromSectionsArg } = await import("./configure.commands.js");
const actualGatewayAuth = await vi.importActual<typeof import("./configure.gateway-auth.js")>(
  "./configure.gateway-auth.js",
);

const written = () => mocks.writeConfigFile.mock.calls.at(-1)![0];
const configureWeb = () => runConfigureWizard({ sections: ["web"] });
const nativeSearchConfig: OpenClawConfig = {
  auth: { profiles: { "openai:default": { provider: "openai", mode: "oauth" } } },
};
const copilotConfig = (config: Record<string, string>): OpenClawConfig => ({
  plugins: { entries: { "github-copilot": { enabled: false, config } } },
});

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
    const runtime = mocks.runtime;
    await runConfigureWizard({});
    expect(mocks.clackOutro).toHaveBeenCalledWith(
      "Config invalid. Run `openclaw doctor --fix` to apply supported repairs, then re-run configure.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.clackSelect).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("dispatches the memory section and persists its verified choice without gateway setup", async () => {
    const config: OpenClawConfig = {
      memory: { search: { cache: { enabled: false } } },
    };
    setupBaseWizardState(config);
    mocks.runMemorySetupFlow.mockImplementation(async (candidate) => ({
      ...candidate,
      memory: {
        ...candidate.memory,
        search: { ...candidate.memory?.search, provider: "openai", model: "embedding-model" },
      },
    }));
    await configureCommandFromSectionsArg(["memory"]);
    expect(mocks.runMemorySetupFlow).toHaveBeenCalledOnce();
    expect(written().memory?.search).toEqual({
      cache: { enabled: false },
      provider: "openai",
      model: "embedding-model",
    });
    expect(mocks.promptGatewayConfig).not.toHaveBeenCalled();
    expect(mocks.maybeInstallDaemon).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "does not write a skipped memory section (section flag: %s)",
    async (flag) => {
      setupBaseWizardState({ gateway: { mode: "local" } });
      queueWizardPrompts({ select: ["local", "memory", "__continue"], confirm: [] });
      await runConfigureWizard(flag ? { sections: ["memory"] } : {});
      expect(mocks.runMemorySetupFlow).toHaveBeenCalledOnce();
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
      expect(mocks.clackOutro).toHaveBeenCalledWith("No configuration changes selected.");
    },
  );

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
    const config = copilotConfig({ region: "us-east-1" });
    const updated = copilotConfig({ region: "us-east-1", accessToken: "plugin-wrote-this" });
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
    await runConfigureWizard({ sections: ["workspace"] });
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
    await expect(runConfigureWizard({ sections: ["workspace"] })).rejects.toThrow(
      "config path changed since last load",
    );
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
    await runConfigureWizard({ sections: ["workspace", "plugins", "skills", "channels"] });
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

  describe("explicit fleet model setup", () => {
    const picked = "anthropic/claude-sonnet-4-6";
    const scopeQuestion = "Where should this model setup apply?";
    const systemFleet: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "alpha" } },
        entries: { alpha: {}, beta: {} },
      },
    };
    const savedAgents = () =>
      committedConfigFiles.read("/tmp/openclaw.json").snapshot.config.agents;

    // The operator answers scripted questions, takes the highlighted default elsewhere, skips
    // provider auth, and picks one model; configure's real model setup writes the result.
    afterEach(() => cliBackendsTesting.resetDepsForTest());

    function operatorAnswers(answers: Record<string, string>) {
      const screen: string[] = [];
      // The model setup exposes no CLI backends; policy checks need no plugin discovery.
      cliBackendsTesting.setDepsForTest({
        resolveRuntimeCliBackends: () => [],
        resolvePluginSetupRegistry: () => ({
          providers: [],
          cliBackends: [],
          configMigrations: [],
          autoEnableProbes: [],
          diagnostics: [],
        }),
      });
      mocks.promptAuthConfig.mockImplementation(actualGatewayAuth.promptAuthConfig);
      modelSetup.authChoice.mockResolvedValue("skip");
      modelSetup.defaultModel.mockResolvedValue({ model: picked });
      modelSetup.allowlist.mockResolvedValue({});
      mocks.clackSelect.mockImplementation(
        async ({ message, initialValue }: { message: string; initialValue?: string }) => {
          screen.push(`${message} [${initialValue ?? ""}]`);
          return answers[message] ?? initialValue;
        },
      );
      return screen;
    }

    it("writes shared defaults while One agent stays highlighted", async () => {
      setupBaseWizardState(systemFleet);
      const screen = operatorAnswers({ [scopeQuestion]: "defaults" });
      await runConfigureWizard({ sections: ["model"] });
      expect(screen).toEqual([`${scopeQuestion} [agent]`]);
      expect(savedAgents()?.defaults?.model).toEqual({ primary: picked });
      expect(savedAgents()?.entries).toEqual({ alpha: {}, beta: {} });
    });

    it("names a setup agent before writing shared defaults on a fleet without a system agent", async () => {
      setupBaseWizardState({ agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } });
      const screen = operatorAnswers({
        [scopeQuestion]: "defaults",
        "Which agent do you want to configure?": "beta",
      });
      await runConfigureWizard({ sections: ["model"] });
      expect(screen).toEqual([
        `${scopeQuestion} [agent]`,
        "Which agent do you want to configure? []",
      ]);
      expect(savedAgents()?.defaults?.model).toEqual({ primary: picked });
      expect(savedAgents()?.entries).toEqual({ alpha: {}, beta: {} });
    });

    it("writes model policy to the agent the operator picks, with the system agent highlighted", async () => {
      setupBaseWizardState(systemFleet);
      const agentQuestion = "Which agent should receive this model policy?";
      const screen = operatorAnswers({ [agentQuestion]: "beta" });
      await runConfigureWizard({ sections: ["model"] });
      expect(screen).toEqual([`${scopeQuestion} [agent]`, `${agentQuestion} [alpha]`]);
      expect(savedAgents()?.entries?.beta?.model).toEqual({ primary: picked });
      expect(savedAgents()?.entries?.alpha).toEqual({});
      expect(savedAgents()?.defaults?.model).toBeUndefined();
    });
  });

  it("does not persist an unprovisionable workspace", async () => {
    agentConfig({ agents: { entries: { ops: { workspace: "/tmp/ops" } } } });
    mocks.ensureWorkspaceAndSessions.mockRejectedValueOnce(new Error("workspace is unwritable"));
    await expect(
      runConfigureWizard({ sections: ["workspace", "plugins", "skills"] }),
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
    await runConfigureWizard({ sections: ["channels"] });
    expect(mocks.setupChannels).not.toHaveBeenCalled();
    expect(mocks.clackSelect).toHaveBeenCalledOnce();
    expect(written()).toEqual(config);
  });
  it("rejects non-interactive configure before prompting (#93953)", async () => {
    const runtime = mocks.runtime;
    mocks.isTerminalInteractive.mockReturnValue(false);
    await configureCommandFromSectionsArg(undefined);
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
    await configureCommandFromSectionsArg([]);
    expect(written().gateway?.mode).toBe("local");
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it("dispatches trimmed section names through the wizard", async () => {
    queueWizardPrompts({ select: ["configure"], confirm: [] });
    await configureCommandFromSectionsArg(["  channels  ", "\tplugins\t"]);
    expect(mocks.setupChannels).toHaveBeenCalledOnce();
    expect(mocks.setupPluginConfig).toHaveBeenCalledOnce();
    expect(mocks.promptGatewayConfig).not.toHaveBeenCalled();
    expect(mocks.writeConfigFile).toHaveBeenCalledOnce();
  });

  it.each([["  ", '""']])(
    "rejects section %j before the terminal guard",
    async (section, diagnostic) => {
      const runtime = mocks.runtime;
      mocks.isTerminalInteractive.mockReturnValue(false);
      await configureCommandFromSectionsArg(["channels", section]);
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining(`Invalid --section: ${diagnostic}`),
      );
      expect(mocks.clackIntro).not.toHaveBeenCalled();
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );
});
