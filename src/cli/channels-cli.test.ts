// Channels CLI tests cover channel command registration and option parsing.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { channelOmitsEnvBackedSetupOption } from "../channels/plugins/cli-add-options.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  resolveChannelsAddChannelFromArgv,
  resolveChannelsAddOptions,
} from "./channels-cli-add-args.js";
import { registerChannelsCli } from "./channels-cli.js";

const listBundledPackageChannelMetadataMock = vi.hoisted(() =>
  vi.fn<() => readonly PluginPackageChannel[]>(() => []),
);
const listRawChannelPluginCatalogEntriesMock = vi.hoisted(() =>
  vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
);
const channelsAddCommandMock = vi.hoisted(() =>
  vi.fn<typeof import("../commands/channels.js").channelsAddCommand>(async () => undefined),
);
const channelsLogsCommandMock = vi.hoisted(() =>
  vi.fn(async (_options: { channel?: string }, _runtime: unknown) => undefined),
);
const channelsDeadLettersMocks = vi.hoisted(() => ({
  channelsDeadLettersListCommand: vi.fn(
    async (_options: { account?: string }, _runtime: unknown) => undefined,
  ),
  channelsDeadLettersResubmitCommand: vi.fn(
    async (_eventId: string, _options: { account?: string }, _runtime: unknown) => undefined,
  ),
}));
const channelsResolveCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const channelsCapabilitiesCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const channelsRemoveCommandMock = vi.hoisted(() => vi.fn(async () => undefined));
const channelAuthMocks = vi.hoisted(() => ({
  runChannelLogin: vi.fn(async () => undefined),
  runChannelLogout: vi.fn(async () => undefined),
}));
const runtimeMock = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
}));

vi.mock("../plugins/bundled-package-channel-metadata.js", () => ({
  listBundledPackageChannelMetadata: listBundledPackageChannelMetadataMock,
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  listRawChannelPluginCatalogEntries: listRawChannelPluginCatalogEntriesMock,
}));

vi.mock("../commands/channels.js", () => ({
  channelsAddCommand: channelsAddCommandMock,
  channelsLogsCommand: channelsLogsCommandMock,
  channelsResolveCommand: channelsResolveCommandMock,
  channelsCapabilitiesCommand: channelsCapabilitiesCommandMock,
  channelsRemoveCommand: channelsRemoveCommandMock,
}));

vi.mock("../commands/channels/dead-letters.js", () => channelsDeadLettersMocks);

vi.mock("./channel-auth.js", () => channelAuthMocks);

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

function channelWithSetupField(
  id: string,
  field: NonNullable<PluginPackageChannel["setup"]>["fields"][number],
): PluginPackageChannel {
  return { id, setup: { fields: [field] } };
}

function createSetupChannel(
  id: string,
  fields: NonNullable<PluginPackageChannel["setup"]>["fields"],
): PluginPackageChannel {
  return { id, setup: { fields } };
}

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

async function runChannelsAddCli(args: string[]) {
  const program = new Command().name("openclaw");
  await registerChannelsCli(program, ["node", "openclaw", ...args]);
  await program.parseAsync(args, { from: "user" });
  return program;
}

describe("registerChannelsCli", () => {
  const originalArgv = [...process.argv];

  afterEach(() => {
    process.argv = [...originalArgv];
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("loads channel-specific add options only for channels add invocations", async () => {
    process.argv = ["node", "openclaw", "channels"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();
    expect(listRawChannelPluginCatalogEntriesMock).not.toHaveBeenCalled();

    process.argv = ["node", "openclaw", "channels", "add", "clickclack", "--help"];
    await registerChannelsCli(new Command().name("openclaw"));

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(listRawChannelPluginCatalogEntriesMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      expected: "ops",
      label: "parent",
      leafAccount: undefined,
      parentAccount: "ops",
      leaf: "list",
    },

    {
      expected: "leaf",
      label: "leaf precedence",
      leafAccount: "leaf",
      parentAccount: "parent",
      leaf: "list",
    },
    {
      expected: "",
      label: "blank parent",
      leafAccount: undefined,
      parentAccount: "",
      leaf: "resubmit",
    },
    { expected: "", label: "blank leaf", leafAccount: "", parentAccount: undefined, leaf: "list" },
  ])(
    "passes a $label --account to dead-letters $leaf",
    async ({ expected, leaf, leafAccount, parentAccount }) => {
      const args = ["channels", "dead-letters"];
      if (parentAccount !== undefined) {
        args.push("--account", parentAccount);
      }
      args.push(leaf);
      if (leaf === "resubmit") {
        args.push("event-1");
      }
      args.push("--channel", "telegram");
      if (leafAccount !== undefined) {
        args.push("--account", leafAccount);
      }
      const program = new Command().name("openclaw").enablePositionalOptions().exitOverride();

      await registerChannelsCli(program, ["node", "openclaw", ...args]);
      await program.parseAsync(args, { from: "user" });

      const options =
        leaf === "list"
          ? channelsDeadLettersMocks.channelsDeadLettersListCommand.mock.calls[0]?.[0]
          : channelsDeadLettersMocks.channelsDeadLettersResubmitCommand.mock.calls[0]?.[1];
      expect(options?.account).toBe(expected);
    },
  );

  it.each([["explicit all", ["channels", "logs", "--channel", "all"], "all"]])(
    "distinguishes an %s channels logs filter",
    async (_label, args, expectedChannel) => {
      const program = new Command().name("openclaw").exitOverride();

      await registerChannelsCli(program, ["node", "openclaw", ...args]);
      await program.parseAsync(args, { from: "user" });

      const optionsCall = channelsLogsCommandMock.mock.calls[0];
      expect(optionsCall).toBeDefined();
      const options = optionsCall![0];
      expect(options?.channel).toBe(expectedChannel);
    },
  );

  it.each([
    { leaf: "capabilities", position: "parent" },

    { leaf: "remove", position: "parent" },
    { leaf: "resolve", position: "parent" },
    { leaf: "add", position: "leaf" },
  ])("forwards the $position --agent option to channels $leaf", async ({ leaf, position }) => {
    const parentArgs =
      position === "leaf" ? [] : ["--agent", position === "both" ? "research" : "ops"];
    const leafArgs = position === "parent" ? [] : ["--agent", "ops"];
    const args = ["channels", ...parentArgs, leaf, ...leafArgs, "--channel", "telegram"];
    if (leaf === "resolve") {
      args.push("room");
    }
    const program = new Command().name("openclaw").enablePositionalOptions().exitOverride();

    await registerChannelsCli(program, ["node", "openclaw", ...args]);
    await program.parseAsync(args, { from: "user" });

    const command = {
      add: channelsAddCommandMock,
      capabilities: channelsCapabilitiesCommandMock,
      login: channelAuthMocks.runChannelLogin,
      logout: channelAuthMocks.runChannelLogout,
      remove: channelsRemoveCommandMock,
      resolve: channelsResolveCommandMock,
    }[leaf];
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ops" }),
      runtimeMock,
      ...(leaf === "add" ? [{ hasFlags: false }] : leaf === "remove" ? [{ hasFlags: true }] : []),
    );
  });

  it("projects channel-owned setup fields into Commander options", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      createSetupChannel("signal", [
        {
          key: "signalTransport",
          kind: "choice",
          choices: ["external-native", "container"],
          cli: {
            flags: "--signal-transport <kind>",
            description: "Signal transport kind",
          },
        },
        {
          key: "autoDiscover",
          kind: "boolean",
          cli: {
            flags: "--auto-discover",
            negatedFlags: "--no-auto-discover",
            description: "Discover channels automatically",
          },
        },
      ]),
    ]);
    process.argv = ["node", "openclaw", "channels", "add", "--channel", "signal", "--help"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(getChannelAddOptionFlags(program)).toContain("--signal-transport <kind>");
    expect(getChannelAddOptionFlags(program)).toContain("--no-auto-discover");
  });

  it("switches the env-backed add hint only for a selected channel without --use-env", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValue([
      channelWithSetupField("telegram", {
        key: "useEnv",
        kind: "boolean",
        cli: { flags: "--use-env", description: "Use Telegram environment credentials" },
      }),
      channelWithSetupField("signal", {
        key: "httpUrl",
        kind: "string",
        cli: { flags: "--http-url <url>", description: "Signal HTTP service URL" },
      }),
      { id: "irc", cliAddOptions: [{ flags: "--token <token>", description: "IRC token" }] },
    ]);
    const registeredFlags = async (channelId: string) => {
      const program = new Command().name("openclaw");
      await registerChannelsCli(program, [
        "node",
        "openclaw",
        "channels",
        "add",
        "--channel",
        channelId,
        "--help",
      ]);
      return getChannelAddOptionFlags(program);
    };

    expect(await registeredFlags("telegram")).toContain("--use-env");
    expect(await registeredFlags("signal")).not.toContain("--use-env");
    expect(await registeredFlags("irc")).toContain("--use-env");
    // Only a *selected* channel that leaves the flag out switches the advice: an
    // unselected or unknown selector has no flag set to describe, so it keeps the
    // generic hint.
    expect(channelOmitsEnvBackedSetupOption("signal")).toBe(true);
    expect(channelOmitsEnvBackedSetupOption("telegram")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption("irc")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption("unlisted")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption(" \t ")).toBe(false);

    listBundledPackageChannelMetadataMock.mockReturnValue([]);
  });

  it.each(["-h"])(
    "keeps generic add help via %s limited to the shared control envelope",
    async (helpFlag) => {
      const program = new Command().name("openclaw");

      await registerChannelsCli(program, ["node", "openclaw", "channels", "add", helpFlag]);

      expect(getChannelAddOptionFlags(program)).toEqual([
        "--channel <name>",
        "--agent <id>",
        "--account <id>",
        "--name <name>",
      ]);
      expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();
    },
  );

  it("forwards only explicitly supplied setup options", () => {
    const sources = new Map<string, "cli" | "default">([
      ["channel", "cli"],
      ["signalTransport", "cli"],
      ["useEnv", "default"],
    ]);

    expect(
      resolveChannelsAddOptions(
        undefined,
        { channel: "signal", signalTransport: "container", useEnv: false },
        {
          getOptionValueSource: (key) => sources.get(key),
        } as Pick<Command, "getOptionValueSource">,
      ),
    ).toEqual({ channel: "signal", signalTransport: "container" });
  });

  it("omits empty legacy integer defaults while still rejecting explicit blanks", async () => {
    const legacyIntChannel = [
      {
        id: "legacy-chat",
        cliAddOptions: [
          {
            flags: "--limit <n>",
            description: "Legacy integer limit",
            defaultValue: "",
            valueType: "int" as const,
          },
        ],
      },
    ];
    listBundledPackageChannelMetadataMock.mockReturnValueOnce(legacyIntChannel);
    listBundledPackageChannelMetadataMock.mockReturnValueOnce(legacyIntChannel);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "legacy-chat",
      "--token",
      "test-token",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "legacy-chat",
        token: "test-token",
      }),
      runtimeMock,
      { hasFlags: true },
    );
    const omittedLimitCall = channelsAddCommandMock.mock.calls[0];
    expect(omittedLimitCall).toBeDefined();
    const omittedLimitOpts = omittedLimitCall![0];
    expect(omittedLimitOpts).not.toHaveProperty("limit");

    channelsAddCommandMock.mockClear();
    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "legacy-chat",
      "--token",
      "test-token",
      "--limit",
      "",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "legacy-chat",
        token: "test-token",
        limit: "",
      }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("preserves empty legacy text defaults when the flag is omitted", async () => {
    const legacyTextChannel = [
      {
        id: "legacy-chat",
        cliAddOptions: [
          {
            flags: "--note <text>",
            description: "Legacy optional note",
            defaultValue: "",
          },
        ],
      },
    ];
    listBundledPackageChannelMetadataMock.mockReturnValueOnce(legacyTextChannel);

    await runChannelsAddCli([
      "channels",
      "add",
      "--channel",
      "legacy-chat",
      "--token",
      "test-token",
    ]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "legacy-chat",
        token: "test-token",
        note: "",
      }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("can force channel-specific add options for completion generation", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);
    process.argv = ["node", "openclaw", "completion", "--write-state"];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, process.argv, { includeSetupOptions: true });

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
  });

  it("normalizes Windows launcher argv before channel-specific add option gating", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      {
        id: "matrix",
        cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
      },
    ]);
    mockProcessPlatform("win32");
    process.argv = [
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\repo\\openclaw.js",
      "channels",
      "add",
      "--channel",
      "matrix",
      "--homeserver",
      "https://matrix.example.org",
    ];
    const program = new Command().name("openclaw");

    await registerChannelsCli(program);

    expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
    expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
  });

  it("resolves a positional channel after a value-taking channel option", async () => {
    const metadata: PluginPackageChannel[] = [
      channelWithSetupField("telegram", {
        key: "token",
        kind: "string",
        cli: { flags: "--token <token>", description: "Telegram bot token" },
      }),
    ];
    listBundledPackageChannelMetadataMock
      .mockReturnValueOnce(metadata)
      .mockReturnValueOnce(metadata);

    await runChannelsAddCli(["channels", "add", "--token", "tok", "telegram"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });

  it("keeps conflicting all-channel flag arities before a positional channel ambiguous", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      channelWithSetupField("chat-a", {
        key: "mode",
        kind: "string",
        cli: { flags: "--mode <mode>", description: "Chat A mode" },
      }),
      channelWithSetupField("chat-b", {
        key: "mode",
        kind: "boolean",
        cli: { flags: "--mode", description: "Enable Chat B mode" },
      }),
    ]);

    await expect(
      resolveChannelsAddChannelFromArgv([
        "node",
        "openclaw",
        "channels",
        "add",
        "--mode",
        "telegram",
      ]),
    ).resolves.toBeUndefined();
  });

  it("finds a positional channel after shared option-value pairs", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      channelWithSetupField("telegram", {
        key: "token",
        kind: "string",
        cli: { flags: "--token <token>", description: "Telegram bot token" },
      }),
    ]);

    await runChannelsAddCli(["channels", "add", "--account", "work", "telegram", "--token", "tok"]);

    expect(channelsAddCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "telegram", account: "work", token: "tok" }),
      runtimeMock,
      { hasFlags: true },
    );
  });
});
