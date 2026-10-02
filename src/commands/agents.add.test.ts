import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { createApiKeyCredential } from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ChannelOnboardingPostWriteHook } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createQueuedWizardPrompter } from "../test-utils/plugin-setup-wizard.js";
import { createAgentForAddCommandTest } from "./agents.add.test-fixtures.js";
import { committedConfigFiles as configFiles } from "./committed-config.test-support.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

type SetupChannels = typeof import("../flows/channel-setup.js").setupChannels;
type EnsureWorkspaceAndSessions = typeof import("./onboard-helpers.js").ensureWorkspaceAndSessions;
type PrepareAuthChoice = typeof import("./auth-choice.apply.js").prepareAuthChoice;

const readConfig = vi.hoisted(() => vi.fn());
const writeConfig = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfig = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfig(params.nextConfig)),
);
const createAgent = vi.hoisted(() => vi.fn());
const creationGate = vi.hoisted(() => vi.fn());
const commitConfig = vi.hoisted(() =>
  vi.fn(async (params: { sourceConfig: Record<string, unknown> }) => {
    await writeConfig(params.sourceConfig);
    return configFiles.write(params.sourceConfig);
  }),
);
const transformConfig = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Agent creation fixture must own the config commit");
  }),
);

const createPrompter = vi.hoisted(() => vi.fn());
const lifecycle = vi.hoisted(() => {
  const state = { active: false };
  return {
    state,
    withPluginLifecycleLease: vi.fn(async (_options, run: () => Promise<unknown>) => {
      state.active = true;
      try {
        return await run();
      } finally {
        state.active = false;
      }
    }),
  };
});
const hasTerminal = vi.hoisted(() => vi.fn(() => true));
const prepareAuth = vi.hoisted(() => vi.fn<PrepareAuthChoice>());
const warnModel = vi.hoisted(() => vi.fn(async () => {}));
const persistAuth = vi.hoisted(() => vi.fn());
const promptAuth = vi.hoisted(() => vi.fn(async () => "fixture-auth"));
const setupChannels = vi.hoisted(() => vi.fn<SetupChannels>(async (config) => config));
const ensureWorkspace = vi.hoisted(() =>
  vi.fn<EnsureWorkspaceAndSessions>(async () => ({
    bootstrapPending: false,
  })),
);

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfig,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await readConfig();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
  writeConfigFile: writeConfig,
  replaceConfigFile: replaceConfig,
}));

vi.mock("../agents/agent-create.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/agent-create.js")>(
    "../agents/agent-create.js",
  )),
  checkAgentCreationGate: creationGate,
  createAgent,
}));

vi.mock("../plugins/install-record-commit.js", async () => ({
  ...(await vi.importActual<typeof import("../plugins/install-record-commit.js")>(
    "../plugins/install-record-commit.js",
  )),
  commitConfigWithPendingPluginInstalls: commitConfig,
  transformConfigWithPendingPluginInstalls: transformConfig,
}));

vi.mock("../wizard/clack-prompter.js", () => ({ createClackPrompter: createPrompter }));

vi.mock("../plugins/plugin-lifecycle-lease.js", () => ({
  withPluginLifecycleLease: lifecycle.withPluginLifecycleLease,
}));

vi.mock("../cli/terminal-interactivity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/terminal-interactivity.js")>()),
  isTerminalInteractive: hasTerminal,
}));

vi.mock("./auth-choice.apply.js", () => ({ prepareAuthChoice: prepareAuth }));
vi.mock("./auth-choice.model-check.js", () => ({ warnIfModelConfigLooksOff: warnModel }));
vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped: promptAuth }));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  persistAuthProfileBatch: persistAuth,
}));

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels,
}));

vi.mock("./onboard-helpers.js", () => ({ ensureWorkspaceAndSessions: ensureWorkspace }));

import { WizardCancelledError } from "../wizard/prompts.js";
import { agentsAddCommand } from "./agents.commands.add.js";

const { persistAuthProfileBatch } = await vi.importActual<
  typeof import("../agents/auth-profiles/upsert-with-lock.js")
>("../agents/auth-profiles/upsert-with-lock.js");

const runtime = createTestRuntime();
const apiKey = (key: string) => createApiKeyCredential("openai", key);
const keyProfile = (profileId: string, key: string) => ({ profileId, credential: apiKey(key) });

describe("agents add command", () => {
  const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agents-add-" });

  beforeAll(async () => {
    await suiteTempDirs.setup();
  });

  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await suiteTempDirs.cleanup();
  });

  beforeEach(() => {
    configFiles.clear();
    vi.clearAllMocks();
    creationGate.mockReset().mockResolvedValue(undefined);
    createAgent.mockReset();
    createAgent.mockImplementation(createAgentForAddCommandTest);
    lifecycle.state.active = false;
    hasTerminal.mockReset().mockReturnValue(true);
    prepareAuth.mockReset();
    persistAuth.mockReset().mockImplementation(persistAuthProfileBatch);
    setConfigSnapshot({ agents: { list: [{ id: "main", default: true }] } });
  });

  async function withState(
    prefix: string,
    run: (state: { root: string; workspaceDir: string; agentDir: string }) => Promise<void>,
  ): Promise<void> {
    const root = await suiteTempDirs.make(prefix);
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
      await run({
        root,
        workspaceDir: path.join(root, "workspace-work"),
        agentDir: path.join(root, "agents", "work", "agent"),
      });
    });
  }

  async function seedAuth(
    root: string,
    agentId: string,
    profiles: AuthProfileStore["profiles"],
    order?: AuthProfileStore["order"],
  ): Promise<string> {
    const agentDir = path.join(root, "agents", agentId, "agent");
    await fs.mkdir(agentDir, { recursive: true });
    saveAuthProfileStore({ version: AUTH_STORE_VERSION, profiles, order }, agentDir);
    return agentDir;
  }

  function setConfigSnapshot(config: Record<string, unknown>): void {
    readConfig.mockResolvedValue({
      ...baseConfigSnapshot,
      config,
      sourceConfig: config,
    });
  }

  function useWizard(
    textValues: string[] = [],
    confirmValues?: boolean[],
    selectValues?: string[],
  ) {
    const wizard = createQueuedWizardPrompter({ textValues, confirmValues, selectValues });
    createPrompter.mockReturnValue(wizard.prompter);
    return wizard;
  }

  function stageGuidedAuth(
    profiles: Array<{ profileId: string; credential: AuthProfileCredential }> = [
      keyProfile("openai:primary", "sk-primary"),
    ],
  ): void {
    prepareAuth.mockImplementationOnce(async ({ config }) => ({
      config: {
        ...config,
        auth: { profiles: { "openai:primary": { provider: "openai", mode: "api_key" } } },
      },
      authProfiles: profiles,
      persistAuthProfiles: async () => {},
    }));
  }

  function stageChannelPostWriteHook(run: ChannelOnboardingPostWriteHook["run"]): void {
    setupChannels.mockImplementationOnce(async (config, _runtime, _prompter, options) => {
      options?.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run });
      return config;
    });
  }

  async function expectRootFailure(execution: Promise<unknown>, message: string) {
    await expect(execution).rejects.toMatchObject({
      name: "ExpectedCliError",
      message,
      humanOutput: message,
      machineOutput: message,
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  }

  it.each([
    {
      name: "a missing workspace with automation flags",
      options: { name: "Work" },
      flags: { hasAutomationFlags: true },
      message: `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    },
    {
      name: "a missing name after a valid workspace",
      options: { workspace: "/tmp/work" },
      flags: { hasAutomationFlags: true },
      message: `Agent name is required in non-interactive mode. Run ${formatCliCommand("openclaw agents add <id> --workspace <path>")}.`,
    },
    {
      name: "an unrepresentable non-interactive name",
      options: { name: "агент✨", workspace: "/tmp/work" },
      flags: { hasAutomationFlags: true },
      message:
        'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    },
    {
      name: "reserved system-agent id openclaw",
      options: { name: "openclaw", workspace: "/tmp/reserved" },
      flags: { hasAutomationFlags: true },
      message: `"openclaw" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`,
    },
  ])("rejects $name through the root failure owner before mutation", async (testCase) => {
    readConfig.mockResolvedValue({ ...baseConfigSnapshot });

    await expectRootFailure(
      agentsAddCommand(testCase.options, runtime, testCase.flags),
      testCase.message,
    );
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("rejects an unrepresentable positional name before targeting an existing agent", async () => {
    setConfigSnapshot({ agents: { entries: { main: {} } } });
    const prompter = useWizard();

    await agentsAddCommand({ name: "агент✨" }, runtime);

    expect(prompter.outro).toHaveBeenCalledWith(
      'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    );
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.note).not.toHaveBeenCalled();
    expect(creationGate).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("rejects a reserved system-agent id from an interactive positional argument", async () => {
    readConfig.mockResolvedValue({ ...baseConfigSnapshot });
    const prompter = useWizard();
    await agentsAddCommand({ name: "openclaw" }, runtime);
    expect(prompter.outro).toHaveBeenCalledWith('"openclaw" is reserved. Choose another name.');
    expect(prompter.text).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  it("refuses the interactive JSON wizard without a usable terminal", async () => {
    readConfig.mockResolvedValue({ ...baseConfigSnapshot });
    hasTerminal.mockReturnValue(false);

    const message =
      "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.";
    await expectRootFailure(agentsAddCommand({ json: true }, runtime), message);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(hasTerminal).toHaveBeenCalledWith(process.stderr);
    expect(readConfig).not.toHaveBeenCalled();
    expect(createPrompter).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("keeps guided JSON stdout isolated while wizard logs and UI use stderr", async () => {
    const config = { agents: { entries: { work: { id: "work" } } } };
    setConfigSnapshot(config);
    useWizard(["/tmp/workspace-work"], [true, false]);
    setupChannels.mockImplementationOnce(async (nextConfig, wizardRuntime, _prompter, options) => {
      wizardRuntime.log("channel log");
      options?.onPostWriteHook?.({
        channel: "matrix",
        accountId: "ops",
        run: async ({ runtime: hookRuntime }) => {
          expect(commitConfig).toHaveBeenCalledOnce();
          hookRuntime.log("hook log");
        },
      });
      return nextConfig;
    });
    ensureWorkspace.mockImplementationOnce(async (_workspace, workspaceRuntime) => {
      workspaceRuntime.log("workspace log");
      return { bootstrapPending: false };
    });

    await agentsAddCommand({ name: "work", json: true }, runtime);

    expect(ensureWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      commitConfig.mock.invocationCallOrder[0]!,
    );
    expect(hasTerminal).toHaveBeenCalledWith(process.stderr);
    expect(createPrompter).toHaveBeenCalledWith(process.stderr);
    expect(runtime.error.mock.calls.map(([message]) => message)).toEqual([
      "channel log",
      "workspace log",
      "hook log",
    ]);
    expect(runtime.log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual({
      agentId: "work",
      name: "work",
      workspace: "/tmp/workspace-work",
      agentDir: expect.stringContaining("/agents/work/agent"),
    });
  });

  it("surfaces the canonical main gate before guided auth or workspace side effects", async () => {
    setConfigSnapshot({ agents: { entries: { robby: { id: "robby" } } } });
    const prompter = useWizard();
    creationGate.mockResolvedValueOnce({
      status: "error",
      reason: "legacy-session-migration-required",
      agentId: "main",
      message: "Run openclaw doctor --fix, then retry.",
    });

    await agentsAddCommand({ name: "main" }, runtime);

    expect(creationGate).toHaveBeenCalledWith("main");
    expect(prompter.outro).toHaveBeenCalledWith("Run openclaw doctor --fix, then retry.");
    expect(prompter.text).not.toHaveBeenCalled();
    expect(prepareAuth).not.toHaveBeenCalled();
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("reports only portable profiles persisted from shared state-db auth", async () => {
    await withState("auth-copy", async ({ workspaceDir, agentDir }) => {
      const sourceStore: AuthProfileStore = {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:api-key": apiKey("sk-test"),
          "openai:oauth": {
            type: "oauth",
            provider: "openai",
            access: "codex-copy-access-token",
            refresh: "codex-copy-refresh-token",
            expires: Date.now() + 60_000,
            copyToAgents: true,
          },
        },
      };
      writeConfigMachineState("auth.sharedStore", { location: "state-db" });
      saveAuthProfileStore(sourceStore);
      const wizard = useWizard(["work", workspaceDir], [true, false]);

      await agentsAddCommand({}, runtime);

      expect(Object.keys(loadPersistedAuthProfileStore(agentDir)?.profiles ?? {})).toEqual([
        "openai:api-key",
      ]);
      expect(wizard.note).toHaveBeenCalledWith(
        'Copied 1 portable auth profile from "main". OAuth profiles stay shared from "main" unless this agent signs in separately.',
        "Auth profiles",
      );
    });
  });

  it.each([
    { source: "__skip__", copy: false },
    { source: "ops", copy: true },
  ])("adds to an explicit fleet with optional auth copy: %j", async (testCase) => {
    await withState("explicit", async ({ root, workspaceDir, agentDir }) => {
      const sourceAgentDir = await seedAuth(root, "ops", {
        "openai:portable": apiKey("fixture-only-key"),
      });
      setConfigSnapshot({
        agents: {
          ownership: "explicit",
          entries: { main: {}, ops: { agentDir: sourceAgentDir } },
        },
      });
      const wizard = useWizard(
        ["work", workspaceDir],
        testCase.source === "__skip__" ? [false] : [testCase.copy, false],
        [testCase.source],
      );

      await agentsAddCommand({}, runtime);

      expect(wizard.outro).toHaveBeenCalledWith('Agent "work" ready.');
      const copied = loadPersistedAuthProfileStore(agentDir);
      expect(copied?.profiles["openai:portable"] !== undefined).toBe(testCase.copy);
      expect(setupChannels).toHaveBeenCalledWith(
        expect.any(Object),
        runtime,
        wizard.prompter,
        expect.objectContaining({ workspaceDir, deferStatusUntilSelection: true }),
      );
    });
  });

  it("fails before config mutation when the source auth store is unreadable", async () => {
    await withState("auth-unreadable", async ({ root, workspaceDir }) => {
      const sourceAgentDir = path.join(root, "agents", "main", "agent");
      await fs.mkdir(sourceAgentDir, { recursive: true });
      const database = new DatabaseSync(resolveAuthProfileDatabasePath(sourceAgentDir));
      database.exec(
        "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
      );
      database.close();
      const wizard = useWizard(["work", workspaceDir]);

      await expect(agentsAddCommand({}, runtime)).rejects.toThrow(
        /auth profile store .* is unreadable; run .*doctor --fix/i,
      );

      expect(writeConfig).not.toHaveBeenCalled();
      expect(wizard.outro).not.toHaveBeenCalled();
    });
  });

  it("does not persist prepared provider auth when a later prompt is cancelled", async () => {
    await withState("auth-cancel-provider", async ({ root, workspaceDir, agentDir }) => {
      await seedAuth(root, "main", {
        "openai:portable": apiKey("portable-cancel"),
      });
      useWizard(["work", workspaceDir], [true, true]);
      stageGuidedAuth();
      warnModel.mockRejectedValueOnce(new WizardCancelledError());

      await agentsAddCommand({}, runtime);

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(persistAuth).not.toHaveBeenCalled();
      expect(createAgent).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
    });
  });

  it("keeps guided auth while applying portable profiles without overwriting", async () => {
    await withState("auth-guided", async ({ root, workspaceDir, agentDir }) => {
      await seedAuth(
        root,
        "main",
        {
          "openai:api-key": apiKey("portable-conflict"),
          "openai:portable": apiKey("portable-retained"),
        },
        { openai: ["openai:api-key", "openai:portable"] },
      );
      const wizard = useWizard(["work", workspaceDir], [true, true], ["openai", "openai-api-key"]);
      stageGuidedAuth([
        keyProfile("openai:api-key", "guided-wins"),
        keyProfile("openai:guided", "guided-retained"),
      ]);

      const create = createAgent.getMockImplementation()!;
      createAgent.mockImplementationOnce(async (params) => {
        expect(lifecycle.state.active).toBe(true);
        expect(persistAuth).not.toHaveBeenCalled();
        return await create(params);
      });
      await agentsAddCommand({}, runtime);
      expect(persistAuth).toHaveBeenCalledOnce();
      expect(warnModel).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        expect.objectContaining({
          agentId: "work",
          pendingAuthProfiles: expect.arrayContaining([
            expect.objectContaining({ profileId: "openai:guided" }),
          ]),
        }),
      );
      const persisted = loadPersistedAuthProfileStore(agentDir);
      expect(persisted?.profiles).toMatchObject({
        "openai:api-key": { key: "guided-wins" },
        "openai:portable": { key: "portable-retained" },
        "openai:guided": { key: "guided-retained" },
      });
      expect(persisted?.order?.openai).toEqual(["openai:api-key", "openai:portable"]);
      expect(wizard.note).toHaveBeenCalledWith(
        'Copied 2 portable auth profiles from "main".',
        "Auth profiles",
      );
    });
  });

  it("publishes no agent when staged provider auth cannot persist atomically", async () => {
    await withState("auth-persist-failure", async ({ workspaceDir, agentDir }) => {
      const profiles = ["first", "second"].map((name) =>
        keyProfile(`openai:${name}`, `sk-${name}`),
      );
      useWizard(["work", workspaceDir], [true]);
      stageGuidedAuth(profiles);
      persistAuth.mockRejectedValueOnce(new Error("injected auth batch persistence failure"));

      await expect(agentsAddCommand({}, runtime)).rejects.toThrow(
        "injected auth batch persistence failure",
      );

      expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
      expect(createAgent).toHaveBeenCalledOnce();
      expect(commitConfig).not.toHaveBeenCalled();
      expect(writeConfig).not.toHaveBeenCalled();
    });
  });

  it.each(["config publication", "later output"])(
    "settles existing-agent auth when %s fails",
    async (failurePoint) => {
      await withState("auth-existing", async ({ workspaceDir, agentDir }) => {
        setConfigSnapshot({
          agents: { entries: { work: { id: "work", workspace: workspaceDir, agentDir } } },
        });
        const wizard = useWizard([workspaceDir], [true, true]);
        stageGuidedAuth();
        const published = failurePoint === "later output";
        (published ? wizard.outro : commitConfig).mockRejectedValueOnce(new Error(failurePoint));
        await expect(agentsAddCommand({ name: "work" }, runtime)).rejects.toThrow(failurePoint);
        const persisted = loadPersistedAuthProfileStore(agentDir);
        if (published) {
          expect(persisted?.profiles["openai:primary"]).toMatchObject({ key: "sk-primary" });
          expect(commitConfig).toHaveBeenCalledWith(
            expect.objectContaining({
              sourceConfig: expect.objectContaining({ auth: expect.any(Object) }),
            }),
          );
        } else {
          expect(persisted).toBeNull();
        }
        expect(createAgent).not.toHaveBeenCalled();
      });
    },
  );

  it("passes canonical created config to fresh-agent post-write hooks", async () => {
    const persistedConfig = {
      agents: { entries: { work: { id: "work", workspace: "/tmp/canonical-workspace" } } },
      plugins: { installs: {} },
    };
    const hook = vi.fn(async () => {});
    useWizard(["work", "/tmp/staged-workspace"], [false]);
    stageChannelPostWriteHook(hook);
    createAgent.mockResolvedValueOnce({
      status: "created",
      agentId: "work",
      name: "work",
      workspace: "/tmp/canonical-workspace",
      agentDir: "/tmp/agent-work",
      bootstrapPending: true,
      config: persistedConfig,
      configPath: configFiles.write(persistedConfig).path,
    });

    await agentsAddCommand({}, runtime);

    expect(hook).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cfg: persistedConfig }));
    expect(createAgent.mock.invocationCallOrder[0]!).toBeLessThan(
      hook.mock.invocationCallOrder[0]!,
    );
  });

  it("does not run channel post-write hooks when fresh agent creation fails", async () => {
    const hook = vi.fn(async () => {});
    useWizard(["work", "/tmp/workspace-work"], [false]);
    stageChannelPostWriteHook(hook);
    createAgent.mockResolvedValueOnce({
      status: "error",
      reason: "write-failed",
      agentId: "work",
      message: "controlled create failure",
    });

    await agentsAddCommand({}, runtime);

    expect(hook).not.toHaveBeenCalled();
  });

  it("does not commit an existing-agent update when workspace provisioning fails", async () => {
    const config = { agents: { entries: { work: { id: "work" } } } };
    setConfigSnapshot(config);
    useWizard(["/tmp/workspace-work"], [true, false]);
    ensureWorkspace.mockRejectedValueOnce(new Error("controlled mkdir failure"));

    await expect(agentsAddCommand({ name: "work" }, runtime)).rejects.toThrow(
      /workspace provisioning.*agent "work".*controlled mkdir failure/i,
    );

    expect(commitConfig).not.toHaveBeenCalled();
    expect(writeConfig).not.toHaveBeenCalled();
  });

  describe("non-interactive config mutation", () => {
    it("creates with explicit non-interactive inputs without a usable terminal", async () => {
      hasTerminal.mockReturnValue(false);

      await agentsAddCommand(
        { name: "Work", workspace: "/tmp/work", nonInteractive: true },
        runtime,
        { hasAutomationFlags: false },
      );

      expect(createAgent).toHaveBeenCalledWith({
        name: "Work",
        workspace: "/tmp/work",
        transformConfig,
      });
      expect(transformConfig).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(runtime.error).not.toHaveBeenCalled();
      expect(hasTerminal).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: "a duplicate agent",
        result: {
          status: "error" as const,
          reason: "already-exists",
          agentId: "work",
          message: 'agent "work" already exists',
        },
        message: 'Agent "work" already exists.',
      },
      {
        name: "a rejected binding",
        result: {
          status: "error" as const,
          reason: "invalid-bindings",
          agentId: "work",
          message: 'Invalid binding "telegram:". Account id is empty.',
        },
        message: 'Invalid binding "telegram:". Account id is empty.',
      },
    ])("reports $name through the root failure owner", async (testCase) => {
      createAgent.mockResolvedValueOnce(testCase.result);

      await expectRootFailure(
        agentsAddCommand({ name: "Work", workspace: "/tmp/work" }, runtime, {
          hasAutomationFlags: true,
        }),
        testCase.message,
      );
    });

    it("renders binding conflicts returned by agent creation", async () => {
      await agentsAddCommand(
        { name: "Work", workspace: "/tmp/work", bind: ["telegram"], json: true },
        runtime,
        { hasAutomationFlags: true },
      );

      const payload = JSON.parse(String(runtime.log.mock.calls.at(-1)?.[0])) as {
        bindings: { added: string[]; conflicts: string[] };
      };
      expect(payload.bindings.added).toEqual([]);
      expect(payload.bindings.conflicts).toEqual(["telegram (agent=other-agent)"]);
    });
  });
});
