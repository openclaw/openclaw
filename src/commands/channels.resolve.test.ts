// Channels resolve tests cover channel/account selection and command output for message routing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelResolverAdapter } from "../channels/plugins/types.adapters.js";
import { channelsResolveCommand } from "./channels/resolve.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getChannelsCommandSecretTargetIds: vi.fn(() => []),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: mocks.getChannelsCommandSecretTargetIds,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: mocks.loadConfig,
    loadConfig: mocks.loadConfig,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("./channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

describe("channelsResolveCommand", () => {
  const runtime = createTestRuntime();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.readConfigFileSnapshot.mockResolvedValue({ hash: "config-1" });
    mocks.refreshPluginRegistryAfterConfigMutation.mockResolvedValue(undefined);
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "telegram",
      plugin: { id: "telegram" },
      configured: ["telegram"],
      source: "explicit",
    });
  });

  it("rejects missing entries before config for a named account", async () => {
    await expect(channelsResolveCommand({ account: "work", entries: [] }, runtime)).rejects.toThrow(
      "At least one entry is required.",
    );
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("retains the unsupported resolver error for a named account", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "telegram",
      configChanged: false,
      pluginInstalled: false,
      plugin: { id: "telegram" },
    });

    await expect(
      channelsResolveCommand({ channel: "telegram", account: "work", entries: ["room"] }, runtime),
    ).rejects.toThrow('Channel "telegram" does not support resolve.');
  });

  it("uses installed channel plugins for explicit target resolution without installing", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { main: {}, ops: {} } },
      channels: {},
    });
    const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>().mockResolvedValue([
      {
        input: "friends",
        resolved: true,
        id: "120363000000@g.us",
        name: "Friends",
      },
    ]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "whatsapp",
      configChanged: false,
      pluginInstalled: false,
      plugin: {
        id: "whatsapp",
        resolver: { resolveTargets },
      },
    });

    await channelsResolveCommand(
      {
        agent: "ops",
        channel: "whatsapp",
        entries: ["friends"],
      },
      runtime,
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(1);
    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops", rawChannel: "whatsapp", allowInstall: false }),
    );
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    expect(resolveTargets.mock.calls[0]?.[0].cfg).toStrictEqual({ channels: {} });
    expect(resolveTargets.mock.calls[0]?.[0].inputs).toStrictEqual(["friends"]);
    expect(resolveTargets).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "group" }));
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });

  it.each([["whitespace-only", "   ", "--agent must not be blank"]])(
    "rejects an %s explicit agent before channel resolution",
    async (_label, agent, message) => {
      mocks.loadConfig.mockReturnValue({
        agents: { entries: { main: {} } },
        channels: {},
      });

      await expect(
        channelsResolveCommand({ agent, channel: "telegram", entries: ["friends"] }, runtime),
      ).rejects.toThrow(message);

      expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
      expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
      expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
      expect(mocks.resolveMessageChannelSelection).not.toHaveBeenCalled();
    },
  );

  it("tells users to add an explicit catalog channel before resolving", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      channelId: "external-chat",
      catalogEntry: { id: "external-chat" },
      configChanged: false,
      pluginInstalled: false,
    });

    await expect(
      channelsResolveCommand(
        {
          channel: "external-chat",
          entries: ["friends"],
        },
        runtime,
      ),
    ).rejects.toThrow(
      /Channel plugin "external-chat" is not installed\. Run .*channels add --channel external-chat.* first\./,
    );
  });

  it.each([
    {
      kind: "auto" as const,
      expected: [
        { input: "@alice", resolved: true, id: "user-1" },
        { input: "#general", resolved: true, id: "group-0" },
        { input: "missing", resolved: false },
        { input: "@alice", resolved: true, id: "user-1" },
      ],
    },
    {
      kind: "channel" as const,
      expected: [
        { input: "@alice", resolved: true, id: "group-0" },
        { input: "#general", resolved: true, id: "group-1" },
        { input: "@alice", resolved: true, id: "group-2" },
      ],
    },
  ])(
    "preserves $kind resolution order and projects only public result fields",
    async ({ kind, expected }) => {
      const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>(
        async ({ inputs, kind: targetKind }) =>
          inputs
            .toReversed()
            .filter((input) => input !== "missing")
            .map((input, index) => ({
              input,
              resolved: true,
              id: `${targetKind}-${index}`,
              providerDetail: "not part of command output",
            })),
      );
      mocks.resolveMessageChannelSelection.mockResolvedValue({
        channel: "fixture",
        plugin: { id: "fixture", resolver: { resolveTargets } },
      });

      await channelsResolveCommand(
        {
          kind,
          json: true,
          entries: ["@alice", "#general", "missing", "@alice"],
        },
        runtime,
      );

      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual(expected);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(resolveTargets.mock.calls.map(([params]) => [params.kind, params.inputs])).toEqual(
        kind === "auto"
          ? [
              ["user", ["@alice", "@alice"]],
              ["group", ["#general", "missing"]],
            ]
          : [["group", ["@alice", "#general", "missing", "@alice"]]],
      );
    },
  );

  it.each([
    { input: "team:T11111111:user:U01234567", chatType: "direct", expectedKind: "user" },
    { input: "team:T11111111:channel:C01234567", chatType: "channel", expectedKind: "group" },
    { input: "fixture:room-id", chatType: "group", expectedKind: "group" },
    { input: "fixture:channel-id", chatType: "channel", expectedKind: "group" },
    { input: "fixture:user-id", chatType: undefined, expectedKind: "user" },
    { input: "general", chatType: undefined, expectedKind: "group" },
    { input: "jane@example.com", chatType: "channel", expectedKind: "user" },
    { input: "@jane.doe", chatType: "channel", expectedKind: "user" },
  ] as const)(
    "classifies $input with plugin inference and existing name heuristics",
    async ({ input, chatType, expectedKind }) => {
      const inferTargetChatType = vi.fn(() => chatType);
      const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>(
        async ({ inputs, kind }) =>
          inputs.map((entry) => ({ input: entry, resolved: kind === expectedKind, id: entry })),
      );
      mocks.resolveInstallableChannelPlugin.mockResolvedValue({
        channelId: "fixture",
        plugin: {
          id: "fixture",
          messaging: { inferTargetChatType },
          resolver: { resolveTargets },
        },
      });

      await channelsResolveCommand({ channel: "fixture", entries: [input], json: true }, runtime);

      expect(resolveTargets).toHaveBeenCalledWith(
        expect.objectContaining({ kind: expectedKind, inputs: [input] }),
      );
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual([
        { input, resolved: true, id: input },
      ]);
    },
  );

  it("keeps directory name queries working when target inference rejects unresolved names", async () => {
    const inferTargetChatType = vi.fn(() => {
      throw new Error("Expected a resolved target ID");
    });
    const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>(async ({ inputs }) =>
      inputs.map((input) => ({ input, resolved: true, id: input })),
    );
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "fixture",
      plugin: { id: "fixture", messaging: { inferTargetChatType }, resolver: { resolveTargets } },
    });
    const entries = ["#general-chat", "@jane.doe", "jane@example.com", "general"];

    await channelsResolveCommand({ kind: "auto", entries, json: true }, runtime);

    expect(resolveTargets.mock.calls.map(([params]) => [params.kind, params.inputs])).toEqual([
      ["group", ["#general-chat", "general"]],
      ["user", ["@jane.doe", "jane@example.com"]],
    ]);
    expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual(
      entries.map((input) => ({ input, resolved: true, id: input })),
    );
  });

  it.each(["user", "group", "channel"] as const)(
    "keeps explicit --kind %s ahead of plugin inference",
    async (kind) => {
      const input = "team:T11111111:user:U01234567";
      const inferTargetChatType = vi.fn(() => "direct" as const);
      const resolveTargets = vi
        .fn<ChannelResolverAdapter["resolveTargets"]>()
        .mockResolvedValue([]);
      mocks.resolveMessageChannelSelection.mockResolvedValue({
        channel: "fixture",
        plugin: { id: "fixture", messaging: { inferTargetChatType }, resolver: { resolveTargets } },
      });

      await channelsResolveCommand({ kind, entries: [input], json: true }, runtime);

      expect(inferTargetChatType).not.toHaveBeenCalled();
      expect(resolveTargets).toHaveBeenCalledWith(
        expect.objectContaining({ kind: kind === "user" ? "user" : "group", inputs: [input] }),
      );
    },
  );
});
