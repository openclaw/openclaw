import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelResolverAdapter } from "../channels/plugins/types.adapters.js";
import { channelsResolveCommand } from "./channels/resolve.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  getChannelsCommandSecretTargetIds: vi.fn(() => []),
  loadConfig: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
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
  const { createTestConfigReadMocks } = await import("./test-runtime-config-helpers.js");
  return {
    ...actual,
    ...createTestConfigReadMocks(mocks, "loadConfig"),
  };
});

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../infra/outbound/channel-selection.js", () => ({
  resolveMessageChannelSelection: mocks.resolveMessageChannelSelection,
}));

vi.mock("./channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

function fixturePlugin(
  resolveTargets: ChannelResolverAdapter["resolveTargets"],
  inferTargetChatType?: () => "direct" | "channel" | undefined,
) {
  return {
    id: "fixture",
    resolver: { resolveTargets },
    ...(inferTargetChatType ? { messaging: { inferTargetChatType } } : {}),
  };
}

function explicitPlugin(plugin: { id: string; resolver?: ChannelResolverAdapter }) {
  mocks.resolveInstallableChannelPlugin.mockResolvedValue({
    channelId: plugin.id,
    plugin,
  });
}

describe("channelsResolveCommand", () => {
  const runtime = createTestRuntime();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ channels: {} });
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "telegram",
      plugin: { id: "telegram" },
    });
  });

  it("rejects missing entries before config for a named account", async () => {
    await expect(channelsResolveCommand({ account: "work", entries: [] }, runtime)).rejects.toThrow(
      "At least one entry is required.",
    );
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("retains the unsupported resolver error for a named account", async () => {
    explicitPlugin({ id: "telegram" });

    await expect(
      channelsResolveCommand({ channel: "telegram", account: "work", entries: ["room"] }, runtime),
    ).rejects.toThrow('Channel "telegram" does not support resolve.');
  });

  it("uses installed channel plugins for explicit target resolution without installing", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { main: {}, ops: {} } },
      channels: {},
    });
    const resolveTargets = vi
      .fn<ChannelResolverAdapter["resolveTargets"]>()
      .mockResolvedValue([
        { input: "friends", resolved: true, id: "120363000000@g.us", name: "Friends" },
      ]);
    explicitPlugin({ id: "whatsapp", resolver: { resolveTargets } });
    await channelsResolveCommand(
      { agent: "ops", channel: "whatsapp", entries: ["friends"] },
      runtime,
    );

    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "ops", rawChannel: "whatsapp", allowInstall: false }),
    );
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });

  it("rejects a whitespace-only explicit agent before channel resolution", async () => {
    mocks.loadConfig.mockReturnValue({
      agents: { entries: { main: {} } },
      channels: {},
    });

    await expect(
      channelsResolveCommand({ agent: "   ", channel: "telegram", entries: ["friends"] }, runtime),
    ).rejects.toThrow("--agent must not be blank");

    expect(mocks.resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.resolveMessageChannelSelection).not.toHaveBeenCalled();
  });

  it("tells users to add an explicit catalog channel before resolving", async () => {
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      catalogEntry: { id: "external-chat" },
    });

    await expect(
      channelsResolveCommand({ channel: "external-chat", entries: ["friends"] }, runtime),
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
        plugin: fixturePlugin(resolveTargets),
      });

      await channelsResolveCommand(
        { kind, json: true, entries: ["@alice", "#general", "missing", "@alice"] },
        runtime,
      );

      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toEqual(expected);
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    { input: "team:T11111111:user:U01234567", chatType: "direct", expectedKind: "user" },
    { input: "team:T11111111:channel:C01234567", chatType: "channel", expectedKind: "group" },
    { input: "fixture:user-id", chatType: undefined, expectedKind: "user" },
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
        plugin: fixturePlugin(resolveTargets, inferTargetChatType),
      });

      await channelsResolveCommand({ channel: "fixture", entries: [input], json: true }, runtime);

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
      plugin: fixturePlugin(resolveTargets, inferTargetChatType),
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

  it("keeps explicit --kind user ahead of plugin inference", async () => {
    const input = "team:T11111111:user:U01234567";
    const inferTargetChatType = vi.fn(() => "direct" as const);
    const resolveTargets = vi.fn<ChannelResolverAdapter["resolveTargets"]>().mockResolvedValue([]);
    mocks.resolveMessageChannelSelection.mockResolvedValue({
      channel: "fixture",
      plugin: fixturePlugin(resolveTargets, inferTargetChatType),
    });

    await channelsResolveCommand({ kind: "user", entries: [input], json: true }, runtime);

    expect(inferTargetChatType).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "user", inputs: [input] }),
    );
  });
});
