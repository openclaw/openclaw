// Channels CLI tests cover channel command registration and option parsing.
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { channelOmitsEnvBackedSetupOption } from "../channels/plugins/cli-add-options.js";
import type { PluginPackageChannel } from "../plugins/manifest.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
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
  vi.fn(async (_options: { channel?: string }) => undefined),
);
const channelsDeadLettersMocks = vi.hoisted(() => ({
  channelsDeadLettersListCommand: vi.fn(async (_options: { account?: string }) => undefined),
  channelsDeadLettersResubmitCommand: vi.fn(
    async (_eventId: string, _options: { account?: string }) => undefined,
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

function setupChannel(
  id: string,
  ...fields: NonNullable<PluginPackageChannel["setup"]>["fields"]
): PluginPackageChannel {
  return { id, setup: { fields } };
}

type SetupField = NonNullable<PluginPackageChannel["setup"]>["fields"][number];
function setupField(
  key: string,
  kind: "string" | "boolean",
  flags: string,
  extra: Partial<SetupField["cli"]> = {},
): SetupField {
  return { key, kind, cli: { flags, description: key, ...extra } };
}

const signalTransport = {
  key: "signalTransport",
  kind: "choice",
  choices: ["external-native", "container"],
  cli: { flags: "--signal-transport <kind>", description: "Signal transport kind" },
} satisfies NonNullable<PluginPackageChannel["setup"]>["fields"][number];
const matrixChannel = {
  id: "matrix",
  cliAddOptions: [{ flags: "--homeserver <url>", description: "Matrix homeserver URL" }],
};
const telegramChannel = setupChannel("telegram", setupField("token", "string", "--token <token>"));
const legacyArgs = ["channels", "add", "--channel", "legacy-chat", "--token", "test-token"];
function legacyChannel(
  flags: string,
  description: string,
  valueType?: "int",
): PluginPackageChannel {
  return {
    id: "legacy-chat",
    cliAddOptions: [{ flags, description, defaultValue: "", ...(valueType ? { valueType } : {}) }],
  };
}
function expectAddCall(options: unknown) {
  expect(channelsAddCommandMock).toHaveBeenCalledWith(options, runtimeMock, { hasFlags: true });
}

function getChannelAddOptionFlags(program: Command): string[] {
  const channels = program.commands.find((command) => command.name() === "channels");
  const add = channels?.commands.find((command) => command.name() === "add");
  return add?.options.map((option) => option.flags) ?? [];
}

async function runChannelsCli(
  args: string[],
  program = new Command().name("openclaw").enablePositionalOptions().exitOverride(),
) {
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
    ["parent", "list", "ops", undefined, "ops"],
    ["leaf precedence", "list", "parent", "leaf", "leaf"],
    ["blank parent", "resubmit", "", undefined, ""],
    ["blank leaf", "list", undefined, "", ""],
  ] as const)(
    "passes a %s --account to dead-letters %s",
    async (_label, leaf, parentAccount, leafAccount, expected) => {
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
      await runChannelsCli(args);

      const options =
        leaf === "list"
          ? channelsDeadLettersMocks.channelsDeadLettersListCommand.mock.calls[0]?.[0]
          : channelsDeadLettersMocks.channelsDeadLettersResubmitCommand.mock.calls[0]?.[1];
      expect(options?.account).toBe(expected);
    },
  );

  it("distinguishes an explicit all channels logs filter", async () => {
    await runChannelsCli(["channels", "logs", "--channel", "all"]);
    const optionsCall = channelsLogsCommandMock.mock.calls[0];
    expect(optionsCall).toBeDefined();
    expect(optionsCall![0]?.channel).toBe("all");
  });

  it.each([
    { leaf: "capabilities", position: "parent" },
    { leaf: "remove", position: "parent" },
    { leaf: "resolve", position: "parent" },
    { leaf: "add", position: "leaf" },
  ])("forwards the $position --agent option to channels $leaf", async ({ leaf, position }) => {
    const parentArgs = position === "leaf" ? [] : ["--agent", "ops"];
    const leafArgs = position === "parent" ? [] : ["--agent", "ops"];
    const args = ["channels", ...parentArgs, leaf, ...leafArgs, "--channel", "telegram"];
    if (leaf === "resolve") {
      args.push("room");
    }
    await runChannelsCli(args);

    const command = {
      add: channelsAddCommandMock,
      capabilities: channelsCapabilitiesCommandMock,
      remove: channelsRemoveCommandMock,
      resolve: channelsResolveCommandMock,
    }[leaf];
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "ops" }),
      runtimeMock,
      ...(leaf === "add" ? [{ hasFlags: false }] : leaf === "remove" ? [{ hasFlags: true }] : []),
    );
  });

  it("switches the env-backed add hint only for a selected channel without --use-env", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValue([
      setupChannel("telegram", setupField("useEnv", "boolean", "--use-env")),
      setupChannel("signal", setupField("httpUrl", "string", "--http-url <url>")),
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
    // Unknown or unselected channels retain the generic hint.
    expect(channelOmitsEnvBackedSetupOption("signal")).toBe(true);
    expect(channelOmitsEnvBackedSetupOption("telegram")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption("irc")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption("unlisted")).toBe(false);
    expect(channelOmitsEnvBackedSetupOption(" \t ")).toBe(false);

    listBundledPackageChannelMetadataMock.mockReturnValue([]);
  });

  it("keeps generic add help limited to the shared control envelope", async () => {
    const program = new Command().name("openclaw");

    await registerChannelsCli(program, ["node", "openclaw", "channels", "add", "-h"]);

    expect(getChannelAddOptionFlags(program)).toEqual([
      "--channel <name>",
      "--agent <id>",
      "--account <id>",
      "--name <name>",
    ]);
    expect(listBundledPackageChannelMetadataMock).not.toHaveBeenCalled();
  });

  it("forwards only explicitly supplied setup options", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      setupChannel(
        "signal",
        signalTransport,
        setupField("useEnv", "boolean", "--use-env", { defaultValue: false }),
        setupField("autoDiscover", "boolean", "--auto-discover", {
          negatedFlags: "--no-auto-discover",
        }),
      ),
    ]);

    await runChannelsCli(
      "channels add --channel signal --signal-transport container --no-auto-discover".split(" "),
    );

    expectAddCall({
      channel: "signal",
      signalTransport: "container",
      autoDiscover: false,
      agent: undefined,
    });
  });

  it.each([
    ["integer default", "--limit <n>", "int", [], {}],
    ["explicit integer blank", "--limit <n>", "int", ["--limit", ""], { limit: "" }],
    ["text default", "--note <text>", undefined, [], { note: "" }],
  ] as const)("preserves legacy %s", async (label, flags, valueType, args, expected) => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      legacyChannel(flags, "Legacy option", valueType),
    ]);
    await runChannelsCli([...legacyArgs, ...args]);
    expectAddCall(
      expect.objectContaining({ channel: "legacy-chat", token: "test-token", ...expected }),
    );
    if (label === "integer default") {
      expect(channelsAddCommandMock.mock.calls[0]?.[0]).not.toHaveProperty("limit");
    }
  });

  it.each(["completion", "Windows launcher"] as const)(
    "loads channel-specific options for %s",
    async (mode) => {
      listBundledPackageChannelMetadataMock.mockReturnValueOnce([matrixChannel]);
      if (mode === "completion") {
        process.argv = ["node", "openclaw", "completion", "--write-state"];
      } else {
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
      }
      const program = new Command().name("openclaw");
      if (mode === "completion") {
        await registerChannelsCli(program, process.argv, { includeSetupOptions: true });
      } else {
        await registerChannelsCli(program);
      }
      expect(listBundledPackageChannelMetadataMock).toHaveBeenCalledTimes(1);
      expect(getChannelAddOptionFlags(program)).toContain("--homeserver <url>");
    },
  );

  it.each([
    ["--token tok telegram", {}, 2],
    ["--account work telegram --token tok", { account: "work" }, 1],
  ] as const)("finds a positional channel in %s", async (args, expected, reads) => {
    for (let read = 0; read < reads; read++) {
      listBundledPackageChannelMetadataMock.mockReturnValueOnce([telegramChannel]);
    }
    await runChannelsCli(["channels", "add", ...args.split(" ")]);
    expectAddCall(expect.objectContaining({ channel: "telegram", token: "tok", ...expected }));
  });

  it("keeps conflicting all-channel flag arities before a positional channel ambiguous", async () => {
    listBundledPackageChannelMetadataMock.mockReturnValueOnce([
      setupChannel("chat-a", setupField("mode", "string", "--mode <mode>")),
      setupChannel("telegram", setupField("mode", "boolean", "--mode")),
    ]);

    const args = ["channels", "add", "--mode", "telegram"];
    const program = new Command().name("openclaw").exitOverride();
    program.configureOutput({ writeErr: () => {} });
    await registerChannelsCli(program, ["node", "openclaw", ...args]);

    await expect(program.parseAsync(args, { from: "user" })).rejects.toMatchObject({
      code: "commander.unknownOption",
      message: expect.stringContaining("unknown option '--mode'"),
    });
    expect(channelsAddCommandMock).not.toHaveBeenCalled();
  });
});
