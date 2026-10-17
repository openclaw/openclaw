import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelResolverAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelMessagingAdapter } from "../channels/plugins/types.core.js";
import { channelsResolveCommand } from "./channels/resolve.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

type ResolveTargets = ChannelResolverAdapter["resolveTargets"];

const {
  resolveCommandSecretRefsViaGateway,
  loadConfig,
  readConfigFileSnapshot,
  applyPluginAutoEnable,
  replaceConfigFile,
  refreshPluginRegistryAfterConfigMutation,
  resolveMessageChannelSelection,
  resolveInstallableChannelPlugin,
} = vi.hoisted(() => ({
  resolveCommandSecretRefsViaGateway: vi.fn(),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  replaceConfigFile: vi.fn(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveMessageChannelSelection: vi.fn(),
  resolveInstallableChannelPlugin: vi.fn(),
}));

vi.mock("../cli/command-secret-gateway.js", () => ({ resolveCommandSecretRefsViaGateway }));
vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => [],
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    captureRuntimeConfigAsyncReader: () => async () => loadConfig(),
    readConfigFileSnapshot,
    replaceConfigFile,
  };
});

vi.mock("../plugins/registry-refresh.js", () => ({ refreshPluginRegistryAfterConfigMutation }));
vi.mock("../config/plugin-auto-enable.js", () => ({ applyPluginAutoEnable }));
vi.mock("../infra/outbound/channel-selection.js", () => ({ resolveMessageChannelSelection }));
vi.mock("./channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin,
}));

const resolved = (input: string, id = input) => ({ input, resolved: true, id });
function selectPlugin(
  resolveTargets?: ResolveTargets,
  messaging?: ChannelMessagingAdapter,
  explicit = false,
  id = "fixture",
) {
  (explicit ? resolveInstallableChannelPlugin : resolveMessageChannelSelection).mockResolvedValue({
    channel: id,
    channelId: id,
    plugin: {
      id,
      ...(resolveTargets ? { resolver: { resolveTargets } } : {}),
      ...(messaging ? { messaging } : {}),
    },
  });
}

describe("channelsResolveCommand", () => {
  const runtime = createTestRuntime();
  const jsonOutput = () => JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
  const resolve = (opts: Parameters<typeof channelsResolveCommand>[0]) =>
    channelsResolveCommand(opts, runtime);

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfig.mockReturnValue({ channels: {} });
    applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    resolveCommandSecretRefsViaGateway.mockResolvedValue({
      resolvedConfig: { channels: {} },
      diagnostics: [],
    });
  });

  it("rejects missing entries before config for a named account", async () => {
    await expect(resolve({ account: "work", entries: [] })).rejects.toThrow(
      "At least one entry is required.",
    );
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it("retains the unsupported resolver error for a named account", async () => {
    selectPlugin(undefined, undefined, true, "telegram");

    await expect(
      resolve({ channel: "telegram", account: "work", entries: ["room"] }),
    ).rejects.toThrow('Channel "telegram" does not support resolve.');
  });

  it("uses installed channel plugins for explicit target resolution without installing", async () => {
    loadConfig.mockReturnValue({
      agents: { entries: { main: {}, ops: {} } },
      channels: {},
    });
    const resolveTargets = vi
      .fn<ResolveTargets>()
      .mockResolvedValue([{ ...resolved("friends", "120363000000@g.us"), name: "Friends" }]);
    selectPlugin(resolveTargets, undefined, true, "whatsapp");

    await resolve({ agent: "ops", channel: "whatsapp", entries: ["friends"] });

    expect(resolveInstallableChannelPlugin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ agentId: "ops", rawChannel: "whatsapp", allowInstall: false }),
    );
    expect(resolveCommandSecretRefsViaGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ agentId: "ops" }),
    );
    expect(replaceConfigFile).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    expect(resolveTargets).toHaveBeenCalledTimes(1);
    expect(resolveTargets.mock.calls[0]?.[0]?.cfg).toStrictEqual({ channels: {} });
    expect(resolveTargets.mock.calls[0]?.[0]).toMatchObject({ inputs: ["friends"], kind: "group" });
    expect(runtime.log).toHaveBeenCalledWith("friends -> 120363000000@g.us (Friends)");
  });

  it("rejects a whitespace-only explicit agent before channel resolution", async () => {
    await expect(
      resolve({ agent: "   ", channel: "telegram", entries: ["friends"] }),
    ).rejects.toThrow("--agent must not be blank");

    expect(readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(resolveCommandSecretRefsViaGateway).not.toHaveBeenCalled();
    expect(resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(resolveMessageChannelSelection).not.toHaveBeenCalled();
  });

  it("tells users to add an explicit catalog channel before resolving", async () => {
    resolveInstallableChannelPlugin.mockResolvedValue({ catalogEntry: { id: "external-chat" } });

    await expect(resolve({ channel: "external-chat", entries: ["friends"] })).rejects.toThrow(
      /Channel plugin "external-chat" is not installed\. Run .*channels add --channel external-chat.* first\./,
    );
  });

  it.each([
    {
      kind: "auto" as const,
      expected: [
        resolved("@alice", "user-1"),
        resolved("#general", "group-0"),
        { input: "missing", resolved: false },
        resolved("@alice", "user-1"),
      ],
    },
    {
      kind: "channel" as const,
      expected: [
        resolved("@alice", "group-0"),
        resolved("#general", "group-1"),
        resolved("@alice", "group-2"),
      ],
    },
  ])(
    "preserves $kind resolution order and projects only public result fields",
    async ({ kind, expected }) => {
      const resolveTargets = vi.fn<ResolveTargets>(async ({ inputs, kind: targetKind }) =>
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
      selectPlugin(resolveTargets);

      await resolve({ kind, json: true, entries: ["@alice", "#general", "missing", "@alice"] });

      expect(jsonOutput()).toEqual(expected);
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
    ["team:T11111111:user:U01234567", "direct", "user", undefined],
    ["team:T11111111:channel:C01234567", "channel", "group", undefined],
    ["fixture:user-id", undefined, "user", undefined],
    ["team:T11111111:user:U01234567", "direct", "user", "user"],
  ] as const)(
    "classifies %s with inference %s as %s (explicit kind %s)",
    async (input, chatType, expectedKind, kind) => {
      const inferTargetChatType = vi.fn(() => chatType);
      const resolveTargets = vi.fn<ResolveTargets>(async ({ inputs, kind: targetKind }) =>
        inputs.map((entry) => ({
          input: entry,
          resolved: targetKind === expectedKind,
          id: entry,
        })),
      );
      selectPlugin(resolveTargets, { inferTargetChatType }, !kind);

      await resolve({ channel: kind ? undefined : "fixture", kind, entries: [input], json: true });

      if (kind) {
        expect(inferTargetChatType).not.toHaveBeenCalled();
      }
      expect(resolveTargets).toHaveBeenCalledWith(
        expect.objectContaining({ kind: expectedKind, inputs: [input] }),
      );
      expect(jsonOutput()).toEqual([resolved(input)]);
    },
  );

  it("keeps directory name queries working when target inference rejects unresolved names", async () => {
    const inferTargetChatType = vi.fn(() => {
      throw new Error("Expected a resolved target ID");
    });
    const resolveTargets = vi.fn<ResolveTargets>(async ({ inputs }) =>
      inputs.map((input) => resolved(input)),
    );
    selectPlugin(resolveTargets, { inferTargetChatType });
    const entries = ["#general-chat", "@jane.doe", "jane@example.com", "general"];

    await resolve({ kind: "auto", entries, json: true });

    expect(resolveTargets.mock.calls.map(([params]) => [params.kind, params.inputs])).toEqual([
      ["group", ["#general-chat", "general"]],
      ["user", ["@jane.doe", "jane@example.com"]],
    ]);
    expect(jsonOutput()).toEqual(entries.map((input) => resolved(input)));
  });
});
