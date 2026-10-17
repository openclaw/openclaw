// Directory CLI tests cover directory command registration and plugin-backed lookups.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { nullChannelDirectorySelf } from "../channels/plugins/directory-adapters.js";
import { createTestConfigSnapshot } from "../commands/test-runtime-config-helpers.js";
import { captureEnv } from "../test-utils/env.js";
import { mockCall } from "../test-utils/mock-call-assertions.js";
import { registerDirectoryCli } from "./directory-cli.js";

const runtimeState = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi, { exitPrefix: "exit" });
});

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getScopedChannelsCommandSecretTargets: vi.fn(() => ({
    targetIds: new Set(["channels.slack.botToken"]),
    allowedPaths: new Set(["channels.slack.botToken"]),
  })),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
  resolveMessageChannelSelection: vi.fn(),
  resolveChannelDefaultAccountId: vi.fn(),
}));

vi.mock("./command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("./command-secret-targets.js", () => ({
  getScopedChannelsCommandSecretTargets: mocks.getScopedChannelsCommandSecretTargets,
}));

// mock-isolation: Directory commands read and mutate synthetic channel config, never host config.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
  captureRuntimeConfigAsyncReader:
    (...args: Parameters<typeof mocks.loadConfig>) =>
    async () =>
      mocks.loadConfig(...args),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  readConfigFileSnapshotForWrite: async () => {
    const snapshot = await mocks.readConfigFileSnapshot();
    return {
      snapshot: { ...snapshot, sourceConfig: snapshot.sourceConfig ?? snapshot.config },
      writeOptions: {},
    };
  },
  replaceConfigFile: mocks.replaceConfigFile,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../commands/channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: mocks.resolveChannelDefaultAccountId,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeState.defaultRuntime,
}));

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value) {
    throw new Error("expected record");
  }
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function firstRecordArg(mockFn: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  return requireRecord(mockCall(mockFn)[0]);
}

function runtimeErrors(): string[] {
  return runtimeState.defaultRuntime.error.mock.calls.map(([message]) => String(message));
}

function runDirectory(args: string[]) {
  const program = new Command().name("openclaw");
  registerDirectoryCli(program);
  return program.parseAsync(["directory", ...args], { from: "user" });
}

function runSelf(mode: string) {
  return runDirectory([
    "self",
    "--channel",
    "demo-directory",
    "--account",
    "account-1",
    ...(mode === "JSON" ? ["--json"] : []),
  ]);
}

function installDirectory(directory: Record<string, unknown>, channelId = "demo-directory") {
  mocks.resolveInstallableChannelPlugin.mockResolvedValue({
    cfg: { channels: { [channelId]: {} } },
    channelId,
    plugin: { id: channelId, directory },
    configChanged: false,
  });
}

async function expectUnavailableSelf(mode: string, self: unknown, reason: string, message: string) {
  installDirectory({ self });
  await runSelf(mode);
  if (mode === "JSON") {
    expect(runtimeState.defaultRuntime.writeJson).toHaveBeenCalledWith({
      status: "unavailable",
      channel: "demo-directory",
      accountId: "account-1",
      reason,
    });
  } else {
    expect(runtimeState.runtimeLogs.join("\n")).toBe(message);
  }
  expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
}

describe("registerDirectoryCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeState.runtimeLogs.length = 0;
    runtimeState.runtimeErrors.length = 0;
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot({ channels: {} }),
      hash: "config-1",
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
    }));
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveChannelDefaultAccountId.mockReturnValue("default");
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "demo-channel",
      plugin: { id: "demo-channel" },
      configured: ["demo-channel"],
      source: "explicit",
    });
    runtimeState.defaultRuntime.exit.mockImplementation((code: number) => {
      throw new Error(`exit:${code}`);
    });
  });

  it("installs an explicit optional directory channel on demand", async () => {
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "DIRECTORY_TEST_SLACK_TOKEN",
    } as const;
    const sourceConfig = { channels: { slack: { botToken: tokenRef } } };
    let runtimeConfig = {
      ...sourceConfig,
      messages: { responsePrefix: "runtime-default" },
    };
    let postWriteRuntimeConfig = runtimeConfig;
    mocks.loadConfig.mockImplementation(() => runtimeConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
      hash: "config-1",
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: {
        ...config,
        channels: { slack: { botToken: "resolved-directory-token" } },
      },
      diagnostics: [],
    }));
    const self = vi.fn().mockResolvedValue({ id: "self-1", name: "Family Phone" });
    mocks.resolveInstallableChannelPlugin.mockImplementation(async ({ cfg }) => ({
      cfg: {
        ...cfg,
        plugins: { entries: { slack: { enabled: true } } },
      },
      channelId: "slack",
      plugin: { id: "slack", directory: { self } },
      configChanged: true,
      pluginInstalled: true,
    }));
    mocks.replaceConfigFile.mockImplementation(async ({ sourceConfig: writtenSource }) => {
      postWriteRuntimeConfig = {
        ...writtenSource,
        messages: { responsePrefix: "runtime-default" },
      };
      runtimeConfig = postWriteRuntimeConfig;
    });

    await runDirectory(["self", "--channel", "slack", "--json"]);

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const installArgs = firstRecordArg(mocks.resolveInstallableChannelPlugin);
    expect(installArgs).toMatchObject({
      rawChannel: "slack",
      allowInstall: true,
      preferRegisteredPlugin: true,
    });
    expect(installArgs.cfg).toEqual(sourceConfig);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(1);
    const replaceArgs = firstRecordArg(mocks.replaceConfigFile);
    expect(replaceArgs.sourceConfig).toEqual({
      channels: { slack: { botToken: tokenRef } },
      plugins: { entries: { slack: { enabled: true } } },
    });
    expect(replaceArgs.sourceConfig).not.toHaveProperty("messages");
    expect(replaceArgs.baseHash).toBe("config-1");
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledOnce();
    expect(firstRecordArg(mocks.resolveCommandSecretRefsViaGateway)).toMatchObject({
      config: postWriteRuntimeConfig,
      commandName: "directory",
      targetIds: new Set(["channels.slack.botToken"]),
      allowedPaths: new Set(["channels.slack.botToken"]),
      mode: "read_only_operational",
    });
    expect(self).toHaveBeenCalledTimes(1);
    expect(firstRecordArg(self).accountId).toBe("default");
    expect(firstRecordArg(self).cfg).toEqual({
      ...postWriteRuntimeConfig,
      channels: { slack: { botToken: "resolved-directory-token" } },
    });
    expect(runtimeState.defaultRuntime.log).toHaveBeenCalledWith(
      JSON.stringify({ id: "self-1", name: "Family Phone" }, null, 2),
    );
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
  });

  describe("group member input", () => {
    const listGroupMembers = vi.fn().mockResolvedValue([]);
    const enabledConfig = {
      channels: { slack: {} },
      plugins: { entries: { slack: { enabled: true } } },
    };

    beforeEach(() => {
      mocks.resolveInstallableChannelPlugin.mockResolvedValue({
        cfg: enabledConfig,
        channelId: "slack",
        plugin: { id: "slack", directory: { listGroupMembers } },
        configChanged: true,
      });
      mocks.replaceConfigFile.mockImplementation(async ({ sourceConfig }) => {
        mocks.loadConfig.mockReturnValue(sourceConfig);
      });
    });

    it.each([""])("rejects blank group ID %j before setup writes", async (groupId) => {
      await expect(
        runDirectory(["groups", "members", "--channel", "slack", "--group-id", groupId, "--json"]),
      ).rejects.toThrow("Missing --group-id");

      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
      expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(listGroupMembers).not.toHaveBeenCalled();
    });

    it("keeps setup writes and trimmed group IDs for valid member lookups", async () => {
      await runDirectory([
        "groups",
        "members",
        "--channel",
        "slack",
        "--group-id",
        " group-1 ",
        "--limit",
        "5",
        "--json",
      ]);

      expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
        sourceConfig: enabledConfig,
        baseHash: "config-1",
        writeOptions: {},
      });
      expect(listGroupMembers).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: "group-1", limit: 5 }),
      );
    });
  });

  it.each([
    ["self", ["self", "--channel", "slack", "--json"]],
    ["peers", ["peers", "list", "--channel", "slack", "--json"]],
  ])("stops %s when canonical config validation exits", async (_label, args) => {
    const directory = {
      self: vi.fn().mockResolvedValue({ id: "self-1" }),
      listPeersLive: vi.fn().mockResolvedValue([]),
      listGroupsLive: vi.fn().mockResolvedValue([]),
      listGroupMembers: vi.fn().mockResolvedValue([]),
    };
    mocks.readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/invalid-openclaw.json",
      exists: true,
      valid: false,
      sourceConfig: {},
      runtimeConfig: {},
      config: {},
      issues: [{ path: "channels.slack", message: "invalid Slack config" }],
      warnings: [],
      legacyIssues: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "slack",
      plugin: { id: "slack", directory },
      configured: ["slack"],
      source: "explicit",
    });
    runtimeState.defaultRuntime.exit.mockImplementation(() => undefined);
    await runDirectory(args);

    expect(Object.values(directory).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.log).not.toHaveBeenCalled();
    expect(runtimeErrors()[0]).toContain("OpenClaw config is invalid");
    expect(runtimeState.defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("uses the auto-enabled config snapshot for omitted channel selection", async () => {
    const autoEnabledConfig = { channels: { whatsapp: {} }, plugins: { allow: ["whatsapp"] } };
    const self = vi.fn().mockResolvedValue({ id: "self-2", name: "WhatsApp Bot" });
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: ["whatsapp"],
    });
    mocks.replaceConfigFile.mockImplementationOnce(async () => {
      mocks.loadConfig.mockReturnValue(autoEnabledConfig);
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "whatsapp",
      plugin: {
        id: "whatsapp",
        directory: { self },
      },
      configured: ["whatsapp"],
      source: "single-configured",
    });

    await runDirectory(["self", "--json"]);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: { channels: {} },
      env: process.env,
    });
    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: autoEnabledConfig,
      channel: null,
      accountResolution: "read_only",
    });
    expect(self).toHaveBeenCalledTimes(1);
    expect(firstRecordArg(self).cfg).toBe(autoEnabledConfig);
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith({
      sourceConfig: autoEnabledConfig,
      baseHash: "config-1",
      writeOptions: {},
    });
  });

  it("inspects an implicit channel before resolving only that account's secrets", async () => {
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "DIRECTORY_TEST_SLACK_TOKEN",
    } as const;
    const sourceConfig = { channels: { slack: { botToken: tokenRef } } };
    const runtimeConfig = {
      ...sourceConfig,
      messages: { responsePrefix: "runtime-default" },
    };
    const calls: string[] = [];
    const self = vi.fn().mockImplementation(async () => {
      calls.push("directory");
      return { id: "U123", name: "Slack Bot" };
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
      hash: "config-1",
    });
    mocks.loadConfig.mockReturnValue(runtimeConfig);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.resolveMessageChannelSelection.mockImplementation(
      async ({ accountResolution }: { accountResolution?: string }) => {
        calls.push("selection");
        if (accountResolution !== "read_only") {
          throw new Error("unresolved SecretRef");
        }
        return {
          channel: "slack",
          plugin: { id: "slack", directory: { self } },
          configured: ["slack"],
          source: "single-configured",
        };
      },
    );
    mocks.getScopedChannelsCommandSecretTargets.mockImplementationOnce(() => {
      calls.push("scope");
      return {
        targetIds: new Set(["channels.slack.botToken"]),
        allowedPaths: new Set(["channels.slack.botToken"]),
      };
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => {
      calls.push("secrets");
      return {
        resolvedConfig: {
          ...config,
          channels: { slack: { botToken: "resolved-directory-token" } },
        },
        diagnostics: [],
      };
    });

    await runDirectory(["self", "--json"]);

    expect(mocks.resolveMessageChannelSelection).toHaveBeenCalledWith({
      cfg: runtimeConfig,
      channel: null,
      accountResolution: "read_only",
    });
    expect(mocks.getScopedChannelsCommandSecretTargets).toHaveBeenCalledWith({
      config: runtimeConfig,
      channel: "slack",
      accountId: "default",
    });
    expect(firstRecordArg(self).cfg).toEqual({
      ...runtimeConfig,
      channels: { slack: { botToken: "resolved-directory-token" } },
    });
    expect(calls).toEqual(["selection", "scope", "secrets", "directory"]);
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it.each(["human", "JSON"])(
    "explains an empty implemented self lookup in %s mode",
    async (mode) => {
      await expectUnavailableSelf(
        mode,
        vi.fn().mockResolvedValue(null),
        "plugin-returned-no-self-identity",
        'No self identity was returned for channel "demo-directory", account "account-1". Verify the account is configured and authenticated, then retry.',
      );
    },
  );

  it.each(["human", "JSON"])("explains an unsupported self lookup in %s mode", async (mode) => {
    await expectUnavailableSelf(
      mode,
      nullChannelDirectorySelf,
      "self-identity-unsupported",
      'Channel "demo-directory" does not expose a self identity.',
    );
  });

  it("names the query context for empty peers", async () => {
    installDirectory({
      listPeers: vi.fn().mockResolvedValue([]),
      listGroups: vi.fn().mockResolvedValue([]),
      listGroupMembers: vi.fn().mockResolvedValue([]),
    });

    await runDirectory(["peers", "list", "--channel", "demo-directory", "--account", "account-1"]);

    const output = runtimeState.runtimeLogs.join("\n");
    expect(output).toContain("No peers found");
    expect(output).toContain('channel "demo-directory"');
    expect(output).toContain('account "account-1"');
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  describe.each([
    { args: ["self"], method: "self", title: "Self" },
    { args: ["groups", "list"], method: "listGroups", title: "Groups" },
    {
      args: ["groups", "members", "--group-id", "group-1"],
      method: "listGroupMembers",
      title: "Group Members",
    },
  ])("$title output", ({ args, method, title }) => {
    it.each([80])("preserves table bytes and raw JSON at width %i", async (columns) => {
      const originalColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns");
      const originalEnv = captureEnv(["TERM"]);
      Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
      process.env.TERM = "xterm";
      try {
        for (const [name, expectedName] of [
          ["  Alice  ", "Alice"],
          [undefined, ""],
          ["A\u001B[31m\r\nB\tC", "A\\r\\nB\\tC"],
        ] as const) {
          const entry = {
            id: "u\u001B]0;directory-id\u0007🦞\n1",
            ...(name === undefined ? {} : { name }),
          };
          const original = structuredClone(entry);
          const isSelf = method === "self";
          installDirectory(
            { [method]: vi.fn().mockResolvedValue(isSelf ? entry : [entry]) },
            "slack",
          );
          runtimeState.defaultRuntime.log.mockClear();
          runtimeState.defaultRuntime.writeJson.mockClear();
          await runDirectory([...args, "--channel", "slack"]);

          const leftWidth = columns / 2 - 2;
          const rightWidth = leftWidth + 1;
          expect(runtimeState.defaultRuntime.log.mock.calls).toEqual([
            [isSelf ? theme.heading(title) : `${theme.heading(title)} ${theme.muted("(1)")}`],
            [
              [
                `┌${"─".repeat(leftWidth)}┬${"─".repeat(rightWidth)}┐`,
                `│ ID${" ".repeat(leftWidth - 3)}│ Name${" ".repeat(rightWidth - 5)}│`,
                `├${"─".repeat(leftWidth)}┼${"─".repeat(rightWidth)}┤`,
                `│ u🦞\\n1${" ".repeat(leftWidth - 7)}│ ${expectedName}${" ".repeat(rightWidth - expectedName.length - 1)}│`,
                `└${"─".repeat(leftWidth)}┴${"─".repeat(rightWidth)}┘`,
              ].join("\n"),
            ],
          ]);
          expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
          await runDirectory([...args, "--channel", "slack", "--json"]);
          expect(runtimeState.defaultRuntime.writeJson.mock.calls).toEqual([
            [isSelf ? original : [original]],
          ]);
          expect(entry).toEqual(original);
        }
      } finally {
        if (originalColumns) {
          Object.defineProperty(process.stdout, "columns", originalColumns);
        } else {
          Reflect.deleteProperty(process.stdout, "columns");
        }
        originalEnv.restore();
      }
    });
  });

  it("reports unsupported directory capability instead of continuing setup for installed plugins", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: { "openclaw-weixin": {} } },
      channelId: "openclaw-weixin",
      plugin: {
        id: "openclaw-weixin",
      },
      configChanged: false,
      pluginInstalled: false,
    });

    await expect(runDirectory(["peers", "list", "--channel", "openclaw-weixin"])).rejects.toThrow(
      "exit:1",
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    const installArgs = firstRecordArg(mocks.resolveInstallableChannelPlugin);
    expect(installArgs.rawChannel).toBe("openclaw-weixin");
    expect(installArgs.allowInstall).toBe(true);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(
      runtimeErrors().some((message) =>
        message.includes("Channel openclaw-weixin does not support directory peers"),
      ),
    ).toBe(true);
  });

  it("bubbles JSON errors for unsupported directory self", async () => {
    installDirectory({});

    await expect(runDirectory(["self", "--channel", "demo-directory", "--json"])).rejects.toThrow(
      "Channel demo-directory does not support directory self",
    );

    expect(runtimeState.defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.error).not.toHaveBeenCalled();
    expect(runtimeState.defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("rejects invalid directory limit", async () => {
    installDirectory(
      {
        listPeers: vi.fn().mockResolvedValue([]),
        listGroups: vi.fn().mockResolvedValue([]),
        listGroupMembers: vi.fn().mockResolvedValue([]),
      },
      "slack",
    );

    await expect(
      runDirectory(["peers", "list", "--channel", "slack", "--limit", "5x"]),
    ).rejects.toThrow("exit:1");

    expect(runtimeErrors().join("\n")).toContain("--limit must be a positive integer.");
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });
});
