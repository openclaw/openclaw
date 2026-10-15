// Channel auth CLI tests cover channel auth command routing and credential prompts.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { materializePluginAutoEnableCandidates } from "../config/plugin-auto-enable.apply.js";
import { makeRegistry } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runChannelLogin, runChannelLogout } from "./channel-auth.js";

const mocks = vi.hoisted(() => ({
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
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.loadConfig>) =>
    async () =>
      mocks.loadConfig(...args),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => ({
    snapshot: await mocks.readConfigFileSnapshot(),
    writeOptions: {},
  }),
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../globals.js", () => ({
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

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

function readFirstCallArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [arg] = mock.mock.calls[0] ?? [];
  if (!arg || typeof arg !== "object") {
    throw new Error("expected first call argument object");
  }
  return arg as Record<string, unknown>;
}

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
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
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
    mocks.replaceConfigFile.mockImplementation(async ({ sourceConfig }) => {
      mocks.loadConfig.mockReturnValue(sourceConfig);
    });
    mocks.commitConfigWithPendingPluginInstalls.mockImplementation(
      async ({ sourceConfig, baseHash }: { sourceConfig: OpenClawConfig; baseHash?: string }) => {
        await mocks.replaceConfigFile({ sourceConfig, baseHash });
        return { config: sourceConfig, installRecords: {}, movedInstallRecords: false };
      },
    );
    mocks.callGateway.mockResolvedValue({ cleared: true, loggedOut: true });
    mocks.listChannelPlugins.mockReturnValue([plugin]);
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default-account");
    mocks.createClackPrompter.mockReturnValue({} as object);
    mocks.ensureChannelSetupPluginInstalled.mockResolvedValue({
      cfg: { channels: { whatsapp: {} } },
      installed: true,
      pluginId: "whatsapp",
    });
    mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue({
      channels: [{ plugin }],
      channelSetups: [],
    });
    mocks.resolveAccount.mockReturnValue({ id: "resolved-account" });
    mocks.login.mockResolvedValue(undefined);
    mocks.logoutAccount.mockResolvedValue({ cleared: true, loggedOut: true });
  });

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
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));

    await runChannelLogout({}, runtime);

    expect(mocks.logoutAccount).toHaveBeenCalledWith(expect.objectContaining({ account }));
  });

  it("keeps repeated credential-free logout free of runtime-only plugin activation writes", async () => {
    const sourceConfig: OpenClawConfig = {
      channels: { whatsapp: { enabled: false } },
      plugins: { allow: ["whatsapp"], entries: { whatsapp: { enabled: true } } },
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1", valid: true, sourceConfig });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }: { config: OpenClawConfig }) =>
      materializePluginAutoEnableCandidates({
        config,
        candidates: [],
        manifestRegistry: makeRegistry([{ id: "memory-core", channels: [], origin: "bundled" }]),
      }),
    );
    mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));
    mocks.logoutAccount.mockResolvedValue({ cleared: false, loggedOut: true });
    mocks.loadConfig.mockReturnValue(sourceConfig);

    await runChannelLogout({ channel: "whatsapp" }, runtime);

    // Runtime plugin schema defaults can appear on a later invocation.
    const laterRuntimeConfig: OpenClawConfig = {
      ...sourceConfig,
      plugins: {
        ...sourceConfig.plugins,
        entries: { ...sourceConfig.plugins?.entries, "memory-core": { config: {} } },
      },
    };
    mocks.loadConfig.mockReturnValue(laterRuntimeConfig);
    await runChannelLogout({ channel: "whatsapp" }, runtime);

    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.logoutAccount.mock.calls.map(([context]) => context.cfg)).toEqual([
      sourceConfig,
      laterRuntimeConfig,
    ]);
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

  it.each([{ status: "skipped", reason: "unconfigured" }] as const)(
    "reports a $reason start decision after saving login",
    async (outcome) => {
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
    },
  );

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

  it("persists auto-enabled config during logout auto-pick too", async () => {
    const autoEnabledCfg = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    mocks.loadConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledCfg, changes: ["whatsapp"] });

    await runChannelLogout({}, runtime);

    expectFields(readFirstCallArg(mocks.callGateway), {
      config: autoEnabledCfg,
      method: "channels.logout",
    });
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: autoEnabledCfg,
      baseHash: "config-1",
    });
  });

  it.each(["prototype"])("ignores %s channels when inferring login", async (kind) => {
    const ignored = {
      id: kind === "prototype" ? "__proto__" : "telegram",
      auth: kind === "prototype" ? { login: vi.fn() } : {},
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

  it.each([
    [
      "local",
      { cleared: false, loggedOut: false },
      "No saved auth was cleared for whatsapp/acct-2. Other credentials may still be active.",
    ],
  ] as const)("reports the completed %s logout result %j", async (route, result, message) => {
    if (route === "local") {
      mocks.callGateway.mockRejectedValue(new Error("gateway unreachable"));
    } else {
      mocks.callGateway.mockResolvedValue(result);
    }
    mocks.logoutAccount.mockResolvedValue(result);

    await runChannelLogout({ channel: "whatsapp", account: "acct-2" }, runtime);

    expect(runtime.log).toHaveBeenLastCalledWith(message);
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
});
