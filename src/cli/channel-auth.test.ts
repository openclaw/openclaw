import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { mockFirstRecordArg } from "../test-utils/mock-call-assertions.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";
import { registerChannelsCli } from "./channels-cli.js";

const mocks = vi.hoisted(() => ({
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  resolveAgentWorkspaceDir: vi.fn(),
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
  getLoadedChannelPlugin: vi.fn(),
  listChannelPlugins: vi.fn(),
  normalizeChannelId: vi.fn(),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  commitConfigWithPendingPluginInstalls: vi.fn(),
  setVerbose: vi.fn(),
  callGateway: vi.fn(),
  createClackPrompter: vi.fn(),
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  login: vi.fn(),
  logoutAccount: vi.fn(),
  resolveAccount: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: mocks.getChannelPluginCatalogEntry,
  listRawChannelPluginCatalogEntries: mocks.listChannelPluginCatalogEntries,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: mocks.getLoadedChannelPlugin,
  listChannelPlugins: mocks.listChannelPlugins,
  normalizeChannelId: mocks.normalizeChannelId,
}));

// mock-isolation: Channel auth exercises fixture reads and writes without loading host credentials.
vi.mock("../config/config.js", async () => {
  const { createTestConfigReadMocks } = await import("../commands/test-runtime-config-helpers.js");
  return {
    ...createTestConfigReadMocks(mocks, "loadConfig"),
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    readConfigFileSnapshotForWrite: async () => ({
      snapshot: await mocks.readConfigFileSnapshot(),
      writeOptions: {},
    }),
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../globals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../globals.js")>()),
  setVerbose: mocks.setVerbose,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../plugins/install-record-commit.js", () => ({
  commitConfigWithPendingPluginInstalls: mocks.commitConfigWithPendingPluginInstalls,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: mocks.createClackPrompter,
}));

vi.mock("../commands/channel-setup/plugin-install.js", () => ({
  ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel:
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
}));

const readFirstCallArg = (mock: Parameters<typeof mockFirstRecordArg>[0]) =>
  mockFirstRecordArg(mock, "channel auth");

function readFirstLogMessage(runtime: { log: ReturnType<typeof vi.fn> }): string {
  const [message] = runtime.log.mock.calls[0] ?? [];
  return String(message);
}

function gatewayRequestError(message: string, gatewayCode: string): Error {
  const error = new Error(message) as Error & { gatewayCode: string };
  error.name = "GatewayClientRequestError";
  error.gatewayCode = gatewayCode;
  return error;
}

describe("channel-auth", () => {
  const runtime = mocks.runtime;
  const source = (config: OpenClawConfig) => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      hash: "config-1",
      valid: true,
      sourceConfig: config,
    });
    mocks.loadConfig.mockReturnValue(config);
  };
  const unreachableGateway = () =>
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));
  const plugin = {
    id: "whatsapp",
    auth: { login: mocks.login },
    gateway: { startAccount: vi.fn(), logoutAccount: mocks.logoutAccount },
    config: {
      listAccountIds: vi.fn().mockReturnValue(["default"]),
      resolveAccount: mocks.resolveAccount,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.normalizeChannelId.mockReturnValue("whatsapp");
    mocks.getLoadedChannelPlugin.mockReturnValue(plugin);
    mocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    mocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {} } });
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      hash: "config-1",
      valid: true,
      sourceConfig: mocks.loadConfig(),
    }));
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.commitConfigWithPendingPluginInstalls.mockImplementation(mocks.replaceConfigFile);
    mocks.callGateway.mockResolvedValue({ cleared: true, loggedOut: true });
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default-account");
    mocks.resolveAccount.mockReturnValue({ id: "resolved-account" });
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAccount.mockResolvedValue({ cleared: true, loggedOut: true });
  });

  it.each([
    ["login", runChannelLogin, mocks.login],
    ["logout", runChannelLogout, mocks.logoutAccount],
  ] as const)(
    "uses source intent and the active runtime snapshot for %s",
    async (_mode, run, action) => {
      const sourceConfig: OpenClawConfig = { channels: { whatsapp: {} } };
      source(sourceConfig);
      const runtimeConfig: OpenClawConfig = {
        ...sourceConfig,
        agents: { defaults: { maxConcurrent: 4 } },
        plugins: { entries: { "memory-core": { config: {} } } },
      };
      mocks.loadConfig.mockReturnValue(runtimeConfig);
      unreachableGateway();

      await run({ channel: "whatsapp" }, runtime);

      expect(mocks.applyPluginAutoEnable).not.toHaveBeenCalled();
      expect(readFirstCallArg(action).cfg).toBe(runtimeConfig);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it("awaits account preparation for inferred local logout", async () => {
    const account = { id: "prepared-account", enabled: true };
    const selectedPlugin = {
      ...plugin,
      config: {
        ...plugin.config,
        resolveAccount: () => {
          throw new Error("legacy account resolution");
        },
        resolveAccountAsync: async () => account,
        isEnabled: (resolved: unknown) => resolved === account,
      },
    };
    mocks.listChannelPlugins.mockReturnValue([selectedPlugin]);
    mocks.getLoadedChannelPlugin.mockReturnValue(selectedPlugin);
    unreachableGateway();

    await runChannelLogout({}, runtime);

    expect(mocks.logoutAccount).toHaveBeenCalledWith(expect.objectContaining({ account }));
  });

  it("skips gateway runtime reconcile in remote mode and warns without failing login", async () => {
    mocks.loadConfig.mockReturnValue({
      gateway: { mode: "remote" },
      channels: { whatsapp: {} },
    });

    await runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime);

    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(readFirstLogMessage(runtime)).toContain("Gateway is in remote mode");
  });

  it("reports an unconfigured start decision after saving login", async () => {
    const outcome = { status: "skipped", reason: "unconfigured" };
    mocks.callGateway.mockResolvedValue({ started: false, outcome });

    await expect(
      runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
    ).resolves.toBeUndefined();

    expect(mocks.login).toHaveBeenCalledOnce();
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(readFirstLogMessage(runtime)).toContain(`whatsapp/acct-1`);
    expect(readFirstLogMessage(runtime)).toContain(outcome.reason);
    expect(readFirstLogMessage(runtime)).toContain(
      "openclaw channels status --channel whatsapp --probe",
    );
  });

  it.each([false, true])(
    "requests a restart for a missing channel (restart fails=%s)",
    async (fails) => {
      mocks.callGateway.mockRejectedValueOnce(
        gatewayRequestError("invalid channels.start channel", "INVALID_REQUEST"),
      );
      if (fails) {
        mocks.callGateway.mockRejectedValueOnce(new Error("restart denied"));
      } else {
        mocks.callGateway.mockResolvedValueOnce(undefined);
      }
      await expect(
        runChannelLogin({ channel: "whatsapp", account: "acct-1" }, runtime),
      ).resolves.toBeUndefined();
      expect(mocks.callGateway).toHaveBeenCalledTimes(2);
      expect(mocks.callGateway).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ method: "channels.start" }),
      );
      expect(mocks.callGateway).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "gateway.restart.request",
          params: { reason: "channel login: load whatsapp" },
        }),
      );
      expect(readFirstLogMessage(runtime)).toContain(
        fails
          ? "running gateway did not restart it: invalid channels.start channel"
          : "Gateway restart requested to load whatsapp",
      );
    },
  );

  it.each(["login", "logout"] as const)(
    "auto-picks %s from the runtime view without persisting unrelated activation",
    async (mode) => {
      const sourceConfig: OpenClawConfig = {
        agents: { defaults: { model: "openai/gpt-5.5" } },
        channels: { whatsapp: {} },
        plugins: { allow: ["whatsapp"] },
      };
      const runtimeConfig = {
        ...sourceConfig,
        agents: { defaults: { model: "openai/gpt-5.5", maxConcurrent: 4 } },
      };
      const autoEnabledCfg = {
        ...sourceConfig,
        channels: { whatsapp: { enabled: true } },
        plugins: {
          allow: ["whatsapp"],
          entries: { codex: { enabled: true }, whatsapp: { enabled: true } },
        },
      };
      source(sourceConfig);
      mocks.loadConfig.mockReturnValue(runtimeConfig);
      mocks.applyPluginAutoEnable.mockReturnValue({
        config: autoEnabledCfg,
        changes: ["codex", "whatsapp"],
      });
      mocks.resolveAccount.mockImplementation((cfg: OpenClawConfig) => ({
        enabled: cfg.channels?.whatsapp?.enabled === true,
      }));
      await (mode === "login" ? runChannelLogin : runChannelLogout)({}, runtime);
      expect(mocks.applyPluginAutoEnable).toHaveBeenCalledExactlyOnceWith({
        config: runtimeConfig,
        env: process.env,
      });
      expect(mocks.resolveAccount.mock.calls[0]?.[0]).toEqual(autoEnabledCfg);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      if (mode === "login") {
        const login = readFirstCallArg(mocks.login);
        expect(login.cfg).toEqual(runtimeConfig);
        expect(login.channelInput).toBe("whatsapp");
      } else {
        const call = readFirstCallArg(mocks.callGateway);
        expect(call.config).toEqual(runtimeConfig);
        expect(call.method).toBe("channels.logout");
      }
    },
  );

  it("ignores prototype channels when inferring login", async () => {
    const ignored = {
      id: "__proto__",
      auth: { login: vi.fn() },
      gateway: {},
      config: {
        listAccountIds: vi.fn().mockReturnValue(["default"]),
        resolveAccount: vi.fn().mockReturnValue({ enabled: true }),
      },
    };
    mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {}, telegram: {} } });
    mocks.listChannelPlugins.mockReturnValue([ignored, plugin]);
    await runChannelLogin({}, runtime);
    expect(mocks.normalizeChannelId).toHaveBeenCalledWith("whatsapp");
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  it("throws for unsupported channel aliases", async () => {
    mocks.normalizeChannelId.mockImplementation(() => undefined);

    await expect(runChannelLogin({ channel: "bad-channel" }, runtime)).rejects.toThrow(
      'Unsupported channel "bad-channel".',
    );
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("rejects unsupported logout", async () => {
    mocks.getLoadedChannelPlugin.mockReturnValueOnce({
      auth: { login: mocks.login },
      gateway: {},
      config: { resolveAccount: mocks.resolveAccount },
    });
    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      'Channel "whatsapp" does not support logout. Run `openclaw channels status --channel whatsapp` to inspect supported actions.',
    );
  });

  it("reports completed local logout with other credentials still active", async () => {
    unreachableGateway();
    mocks.logoutAccount.mockResolvedValue({ cleared: false, loggedOut: false });

    await runChannelLogout({ channel: "whatsapp", account: "acct-2" }, runtime);

    expect(runtime.log).toHaveBeenLastCalledWith(
      "No saved auth was cleared for whatsapp/acct-2. Other credentials may still be active.",
    );
  });

  it("does not report completion or clear local auth when remote logout fails", async () => {
    mocks.loadConfig.mockReturnValue({ gateway: { mode: "remote" }, channels: { whatsapp: {} } });
    mocks.callGateway.mockRejectedValue(new Error("remote gateway unreachable"));

    await expect(runChannelLogout({ channel: "whatsapp" }, runtime)).rejects.toThrow(
      "remote gateway unreachable",
    );

    expect(mocks.logoutAccount).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each(["multiple", "disabled"] as const)(
    "does not log out when omitted channel has %s eligible selection",
    async (selection) => {
      mocks.listChannelPlugins.mockReturnValue(
        selection === "multiple" ? [plugin, { ...plugin, id: "zalouser" }] : [plugin],
      );
      if (selection === "multiple") {
        mocks.loadConfig.mockReturnValue({ channels: { whatsapp: {}, zalouser: {} } });
      } else if (selection === "disabled") {
        mocks.loadConfig.mockReturnValue({ channels: { whatsapp: { enabled: false } } });
      }

      await expect(runChannelLogout({}, runtime)).rejects.toThrow(
        selection === "multiple"
          ? "Multiple configured channels support logout"
          : "No configured channel supports logout",
      );
      expect(mocks.callGateway).not.toHaveBeenCalled();
      expect(mocks.logoutAccount).not.toHaveBeenCalled();
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  describe("Commander auth owner", () => {
    async function runAuth(mode: string, parent: string[] = [], leaf: string[] = []) {
      const args = [
        "channels",
        ...parent,
        mode,
        ...leaf,
        "--channel",
        plugin.id,
        "--account",
        "work",
      ];
      const program = new Command()
        .name("openclaw")
        .enablePositionalOptions()
        .exitOverride()
        .configureOutput({ writeErr: () => undefined });
      await registerChannelsCli(program, ["node", "openclaw", ...args]);
      await program.parseAsync(args, { from: "user" });
    }

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
        "../agents/agent-scope.js",
      );
      mocks.resolveAgentWorkspaceDir.mockImplementation(actual.resolveAgentWorkspaceDir);
      source({
        agents: {
          ownership: "explicit",
          entries: {
            research: { workspace: "/tmp/research-workspace" },
            ops: { workspace: "/tmp/ops-workspace" },
          },
        },
      });
      unreachableGateway();
      mocks.listChannelPluginCatalogEntries.mockReturnValue([
        {
          id: plugin.id,
          pluginId: plugin.id,
          origin: "bundled",
          meta: {
            id: plugin.id,
            label: "Fixture",
            selectionLabel: "Fixture",
            docsPath: "",
            blurb: "",
          },
          install: { npmSpec: plugin.id },
        },
      ]);
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
        channels: [{ plugin }],
        channelSetups: [],
      });
    });

    it.each(["login", "logout"])(
      "retains the leaf owner through %s plugin discovery",
      async (mode) => {
        mocks.getLoadedChannelPlugin.mockReturnValue(undefined);
        await runAuth(mode, ["--agent", "research"], ["--agent", " ops "]);
        expect(runtime.error).not.toHaveBeenCalled();
        expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
          expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
        );
        expect(mode === "login" ? mocks.login : mocks.logoutAccount).toHaveBeenCalledWith(
          expect.objectContaining({ accountId: "work" }),
        );
      },
    );

    it("keeps an ownerless fleet from auth", async () => {
      await expect(runAuth("logout")).rejects.toMatchObject({
        name: "AgentSelectionRequiredError",
        message: expect.stringContaining("no explicit owner"),
      });
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(mocks.listChannelPluginCatalogEntries).not.toHaveBeenCalled();
      expect(mocks.loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
      expect(mocks.login).not.toHaveBeenCalled();
      expect(mocks.logoutAccount).not.toHaveBeenCalled();
    });

    it.each([
      { agent: "OPS", error: 'Unknown agent id "OPS"' },
      { agent: " ", error: "--agent must not be blank" },
    ])("rejects invalid explicit owner '$agent' before discovery", async ({ agent, error }) => {
      const config = mocks.loadConfig();
      config.agents.defaults = { systemAgent: { agentId: "research" } };
      await runAuth("logout", ["--agent", agent]);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.listChannelPluginCatalogEntries).not.toHaveBeenCalled();
      expect(mocks.login).not.toHaveBeenCalled();
      expect(mocks.logoutAccount).not.toHaveBeenCalled();
    });
  });
});
