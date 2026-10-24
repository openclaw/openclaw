import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it as baseIt, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "../agents/auth-profiles/credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ChannelOnboardingPostWriteHook } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import { defaultRuntime } from "../runtime.js";
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
type AddOptions = Parameters<typeof agentsAddCommand>[0];
const apiKey = (key: string) => createApiKeyCredential("openai", key);
const keyProfile = (profileId: string, key: string) => ({ profileId, credential: apiKey(key) });
const add = (options: AddOptions = {}, hasAutomationFlags?: boolean) =>
  agentsAddCommand(options, { hasAutomationFlags });
function expectUnused(...mocks: Array<{ mock: { calls: unknown[] } }>) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

const suiteTempDirs = createSuiteTempRootTracker({ prefix: "openclaw-agents-add-" });
const it = baseIt.extend<{ state: { root: string; workspaceDir: string; agentDir: string } }>({
  state: async ({ task: _task }, use) => {
    const root = await suiteTempDirs.make("auth");
    await withEnvAsync({ OPENCLAW_STATE_DIR: root }, () =>
      use({
        root,
        workspaceDir: path.join(root, "workspace-work"),
        agentDir: path.join(root, "agents", "work", "agent"),
      }),
    );
  },
});
describe("agents add command", () => {
  beforeAll(() => suiteTempDirs.setup());

  afterAll(async () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    await suiteTempDirs.cleanup();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    configFiles.clear();
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
    vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
    vi.spyOn(defaultRuntime, "exit").mockImplementation(runtime.exit);
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) =>
      runtime.log(JSON.stringify(value, null, 2)),
    );
    creationGate.mockReset().mockResolvedValue(undefined);
    createAgent.mockReset();
    createAgent.mockImplementation(createAgentForAddCommandTest);
    lifecycle.state.active = false;
    hasTerminal.mockReset().mockReturnValue(true);
    prepareAuth.mockReset();
    persistAuth.mockReset().mockImplementation(persistAuthProfileBatch);
    setConfigSnapshot({ agents: { entries: { main: {} } } });
  });

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

  function existingAgentWizard() {
    setConfigSnapshot({ agents: { entries: { work: {} } } });
    return useWizard(["/tmp/workspace-work"], [true, false]);
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
    expectUnused(runtime.error, runtime.exit, writeConfig);
  }

  it("preserves the recovery owner's refusal for an existing held agent", async () => {
    const message =
      "Agent main has held databases. Restore its original agentDir and session.store configuration, then rerun agents add to restore the preserved store.";
    createAgent.mockResolvedValueOnce({
      status: "error",
      reason: "already-exists",
      agentId: "main",
      message,
    });
    await expectRootFailure(add({ name: "main", workspace: "/tmp/main" }, true), message);
  });

  it.each<[AddOptions, string]>([
    [
      { name: "Work" },
      `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    ],
    [
      { workspace: "/tmp/work" },
      `Agent name is required in non-interactive mode. Run ${formatCliCommand("openclaw agents add <id> --workspace <path>")}.`,
    ],
    [
      { name: "агент✨", workspace: "/tmp/work" },
      'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    ],
    [
      { name: "openclaw", workspace: "/tmp/reserved" },
      `"openclaw" is reserved. Choose another name, or run ${formatCliCommand("openclaw agents list")} to inspect configured agents.`,
    ],
  ])("rejects automated creation %j before mutation", async (options, message) => {
    readConfig.mockResolvedValue({ ...baseConfigSnapshot });

    await expectRootFailure(add(options, true), message);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it.each([
    [
      "агент✨",
      'Agent name "агент✨" has no valid id characters. Use at least one letter a-z or digit.',
    ],
    ["openclaw", '"openclaw" is reserved. Choose another name.'],
  ])("rejects invalid interactive positional name %s before mutation", async (name, message) => {
    const prompter = useWizard();
    await add({ name });
    expect(prompter.outro).toHaveBeenCalledWith(message);
    expectUnused(
      prompter.text,
      prompter.confirm,
      prompter.note,
      creationGate,
      createAgent,
      writeConfig,
    );
  });

  it("refuses the interactive JSON wizard without a usable terminal", async () => {
    readConfig.mockResolvedValue({ ...baseConfigSnapshot });
    hasTerminal.mockReturnValue(false);

    const message =
      "Agent creation needs an interactive TTY. Use `openclaw agents add <id> --non-interactive --workspace <dir>` for automation.";
    await expectRootFailure(add({ json: true }), message);
    expect(hasTerminal).toHaveBeenCalledWith(process.stderr);
    expectUnused(runtime.log, readConfig, createPrompter, createAgent);
  });

  it("keeps guided JSON stdout isolated while wizard logs and UI use stderr", async () => {
    existingAgentWizard();
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

    await add({ name: "work", json: true });

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
    setConfigSnapshot({ agents: { entries: { robby: {} } } });
    const prompter = useWizard();
    creationGate.mockResolvedValueOnce({
      message: "Run openclaw doctor --fix, then retry.",
    });

    await add({ name: "main" });

    expect(creationGate).toHaveBeenCalledWith("main");
    expect(prompter.outro).toHaveBeenCalledWith("Run openclaw doctor --fix, then retry.");
    expectUnused(prompter.text, prepareAuth, createAgent);
  });

  it("reports only portable profiles persisted from shared state-db auth", async ({
    state: { workspaceDir, agentDir },
  }) => {
    writeConfigMachineState("auth.sharedStore", { location: "state-db" });
    saveAuthProfileStore({
      version: AUTH_STORE_VERSION,
      profiles: {
        "openai:api-key": apiKey("sk-test"),
        "openai:oauth": createOAuthRefreshCredential({ copyToAgents: true }),
      },
    });
    const wizard = useWizard(["work", workspaceDir], [true, false]);

    await add();

    expect(Object.keys(loadPersistedAuthProfileStore(agentDir)?.profiles ?? {})).toEqual([
      "openai:api-key",
    ]);
    expect(wizard.note).toHaveBeenCalledWith(
      'Copied 1 portable auth profile from "main". OAuth profiles stay shared from "main" unless this agent signs in separately.',
      "Auth profiles",
    );
  });

  it("copies auth from a selected agent in an explicit fleet", async ({
    state: { root, workspaceDir, agentDir },
  }) => {
    const sourceAgentDir = await seedAuth(root, "ops", {
      "openai:portable": apiKey("fixture-only-key"),
    });
    setConfigSnapshot({
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: { agentDir: sourceAgentDir } },
      },
    });
    const wizard = useWizard(["work", workspaceDir], [true, false], ["ops"]);

    await add();

    expect(wizard.outro).toHaveBeenCalledWith('Agent "work" ready.');
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles["openai:portable"]).toBeDefined();
    expect(setupChannels).toHaveBeenCalledWith(
      expect.any(Object),
      defaultRuntime,
      wizard.prompter,
      expect.objectContaining({ workspaceDir, deferStatusUntilSelection: true }),
    );
  });

  it("fails before config mutation when the source auth store is unreadable", async ({
    state: { root, workspaceDir },
  }) => {
    const sourceAgentDir = path.join(root, "agents", "main", "agent");
    await fs.mkdir(sourceAgentDir, { recursive: true });
    const database = new DatabaseSync(resolveAuthProfileDatabasePath(sourceAgentDir));
    database.exec(
      "CREATE VIEW auth_profile_store AS SELECT 'primary' AS store_key, '{}' AS store_json;",
    );
    database.close();
    const wizard = useWizard(["work", workspaceDir]);

    await expect(add()).rejects.toThrow(/auth profile store .* is unreadable; run .*doctor --fix/i);

    expect(writeConfig).not.toHaveBeenCalled();
    expect(wizard.outro).not.toHaveBeenCalled();
  });

  it("does not persist prepared provider auth when a later prompt is cancelled", async ({
    state: { root, workspaceDir, agentDir },
  }) => {
    await seedAuth(root, "main", {
      "openai:portable": apiKey("portable-cancel"),
    });
    useWizard(["work", workspaceDir], [true, true]);
    stageGuidedAuth();
    warnModel.mockRejectedValueOnce(new WizardCancelledError());

    await add();

    expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
    expectUnused(persistAuth, createAgent);
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("keeps guided auth while applying portable profiles without overwriting", async ({
    state: { root, workspaceDir, agentDir },
  }) => {
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
    await add();
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
    expect(persisted).toMatchObject({
      profiles: {
        "openai:api-key": { key: "guided-wins" },
        "openai:portable": { key: "portable-retained" },
        "openai:guided": { key: "guided-retained" },
      },
      order: { openai: ["openai:api-key", "openai:portable"] },
    });
    expect(wizard.note).toHaveBeenCalledWith(
      'Copied 2 portable auth profiles from "main".',
      "Auth profiles",
    );
  });

  it("publishes no agent when staged provider auth cannot persist atomically", async ({
    state: { workspaceDir, agentDir },
  }) => {
    const profiles = ["first", "second"].map((name) => keyProfile(`openai:${name}`, `sk-${name}`));
    useWizard(["work", workspaceDir], [true]);
    stageGuidedAuth(profiles);
    persistAuth.mockRejectedValueOnce(new Error("injected auth batch persistence failure"));

    await expect(add()).rejects.toThrow("injected auth batch persistence failure");

    expect(loadPersistedAuthProfileStore(agentDir)).toBeNull();
    expect(createAgent).toHaveBeenCalledOnce();
    expectUnused(commitConfig, writeConfig);
  });

  it.for(["config publication", "later output"])(
    "settles existing-agent auth when %s fails",
    async (failurePoint, { state: { workspaceDir, agentDir } }) => {
      setConfigSnapshot({
        agents: { entries: { work: { workspace: workspaceDir, agentDir } } },
      });
      const wizard = useWizard([workspaceDir], [true, true]);
      stageGuidedAuth();
      const published = failurePoint === "later output";
      (published ? wizard.outro : commitConfig).mockRejectedValueOnce(new Error(failurePoint));
      await expect(add({ name: "work" })).rejects.toThrow(failurePoint);
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
    },
  );

  it.for([true, false])(
    "runs fresh-agent hooks only after successful creation: %s",
    async (created) => {
      const config = {
        agents: { entries: { work: { workspace: "/tmp/canonical-workspace" } } },
        plugins: { installs: {} },
      };
      const hook = vi.fn(async () => {});
      useWizard(["work", "/tmp/staged-workspace"], [false]);
      stageChannelPostWriteHook(hook);
      createAgent.mockResolvedValueOnce(
        created
          ? {
              status: "created",
              agentId: "work",
              name: "work",
              workspace: "/tmp/canonical-workspace",
              agentDir: "/tmp/agent-work",
              configPath: configFiles.write(config).path,
            }
          : {
              status: "error",
              reason: "write-failed",
              agentId: "work",
              message: "controlled create failure",
            },
      );
      await add();
      if (created) {
        expect(hook).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cfg: config }));
        expect(createAgent.mock.invocationCallOrder[0]!).toBeLessThan(
          hook.mock.invocationCallOrder[0]!,
        );
      } else {
        expect(hook).not.toHaveBeenCalled();
      }
    },
  );

  it("does not commit an existing-agent update when workspace provisioning fails", async () => {
    existingAgentWizard();
    ensureWorkspace.mockRejectedValueOnce(new Error("controlled mkdir failure"));

    await expect(add({ name: "work" })).rejects.toThrow(
      /workspace provisioning.*agent "work".*controlled mkdir failure/i,
    );

    expectUnused(commitConfig, writeConfig);
  });

  it.for([false, true])(
    "creates without a terminal and reports binding conflicts: %s",
    async (conflicts) => {
      hasTerminal.mockReturnValue(false);
      await add(
        {
          name: "Work",
          workspace: "/tmp/work",
          ...(conflicts ? { bind: ["telegram"], json: true } : { nonInteractive: true }),
        },
        conflicts,
      );
      expect(createAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Work",
          workspace: "/tmp/work",
          transformConfig,
        }),
      );
      expectUnused(transformConfig, runtime.error, hasTerminal);
      if (conflicts) {
        const payload: { bindings: { added: string[]; conflicts: string[] } } = JSON.parse(
          String(runtime.log.mock.calls.at(-1)?.[0]),
        );
        expect(payload.bindings).toMatchObject({
          added: [],
          conflicts: ["telegram (agent=other-agent)"],
        });
        expect(runtime.exit).toHaveBeenCalledWith(1);
      } else {
        expect(runtime.exit).not.toHaveBeenCalled();
      }
    },
  );
});
