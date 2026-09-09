import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerChannelsCli } from "./channels-cli.js";
import type { ProgramContext } from "./program/context.js";
import { registerMessageCommands } from "./program/register.message.js";

type AccountOptions = {
  account?: string;
  channel?: string;
  json?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
};

const context: ProgramContext = {
  programVersion: "test",
  channelOptions: ["discord"],
  messageChannelOptions: "discord",
  agentChannelOptions: "last|discord",
};

const messageRoutes: [string, string[]][] = [
  ["send", ["--target", "room", "--message", "hello"]],
  ["broadcast", ["--targets", "room", "--message", "hello"]],
  ["poll", ["--target", "room", "--poll-question", "Lunch?", "--poll-option", "Soup"]],
  ["react", ["--target", "room", "--message-id", "message"]],
  ["reactions", ["--target", "room", "--message-id", "message"]],
  ["read", ["--target", "room"]],
  ["edit", ["--target", "room", "--message-id", "message", "--message", "hello"]],
  ["delete", ["--target", "room", "--message-id", "message"]],
  ["pin", ["--target", "room", "--message-id", "message"]],
  ["unpin", ["--target", "room", "--message-id", "message"]],
  ["pins", ["--target", "room"]],
  ["permissions", ["--target", "room"]],
  ["search", ["--guild-id", "guild", "--query", "hello"]],
  ["thread create", ["--target", "room", "--thread-name", "topic"]],
  ["thread list", ["--guild-id", "guild"]],
  ["thread reply", ["--target", "room", "--message", "hello"]],
  ["emoji list", []],
  ["emoji upload", ["--guild-id", "guild", "--emoji-name", "smile", "--media", "emoji.png"]],
  ["sticker send", ["--target", "room", "--sticker-id", "sticker"]],
  [
    "sticker upload",
    [
      "--guild-id",
      "guild",
      "--sticker-name",
      "smile",
      "--sticker-desc",
      "hello",
      "--sticker-tags",
      "smile",
      "--media",
      "sticker.png",
    ],
  ],
  ["role info", ["--guild-id", "guild"]],
  ["role add", ["--guild-id", "guild", "--user-id", "user", "--role-id", "role"]],
  ["role remove", ["--guild-id", "guild", "--user-id", "user", "--role-id", "role"]],
  ["channel info", ["--target", "room"]],
  ["channel list", ["--guild-id", "guild"]],
  ["member info", ["--user-id", "user"]],
  ["voice status", ["--guild-id", "guild", "--user-id", "user"]],
  ["event list", ["--guild-id", "guild"]],
  [
    "event create",
    ["--guild-id", "guild", "--event-name", "lunch", "--start-time", "2027-01-01T12:00:00Z"],
  ],
  ["timeout", ["--guild-id", "guild", "--user-id", "user", "--duration-min", "1"]],
  ["kick", ["--guild-id", "guild", "--user-id", "user"]],
  ["ban", ["--guild-id", "guild", "--user-id", "user"]],
];

const messageCases = messageRoutes.map(([name, required]) => ({
  name: `message ${name}`,
  args: [
    "message",
    ...name.split(" "),
    ...required,
    "--channel",
    "discord",
    "--json",
    "--dry-run",
    "--verbose",
  ],
}));
const channelCases = [
  {
    name: "channels capabilities",
    args: ["channels", "capabilities", "--channel", "discord", "--json"],
  },
  {
    name: "channels resolve",
    args: ["channels", "resolve", "room", "--channel", "discord", "--json"],
  },
];
const representativeCases = [
  ...messageCases.filter(({ name }) =>
    ["message send", "message thread create", "message broadcast"].includes(name),
  ),
  ...channelCases,
];

async function createProgram(args: string[]) {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => undefined });
  if (args[0] === "message") {
    registerMessageCommands(program, context);
  } else {
    await registerChannelsCli(program, ["node", "openclaw", ...args]);
  }
  const startup = vi.fn((_root: Command, _action: Command) => {
    throw new Error("command startup reached");
  });
  program.hook("preAction", startup);
  return { program, startup };
}

describe("account selector option boundaries", () => {
  it("covers every registered message action", () => {
    const program = new Command();
    registerMessageCommands(program, context);
    function leaves(command: Command, prefix: string): string[] {
      return command.commands.flatMap((child) => {
        const name = `${prefix} ${child.name()}`.trim();
        return child.commands.length ? leaves(child, name) : [name];
      });
    }
    expect(leaves(program, "").toSorted()).toEqual(messageCases.map(({ name }) => name).toSorted());
  });

  describe.each([...messageCases, ...channelCases])("$name", ({ args }) => {
    it("preserves valid omitted input before action", async () => {
      const { program, startup } = await createProgram(args);
      await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
        "command startup reached",
      );
      expect(startup.mock.calls.map(([, action]) => action.opts<AccountOptions>().account)).toEqual(
        [undefined],
      );
    });

    it.each(["", " \t\n "])("rejects blank %j before command startup", async (account) => {
      const { program, startup } = await createProgram(args);
      await expect(
        program.parseAsync([...args, "--account", account], { from: "user" }),
      ).rejects.toThrow("--account must not be blank");
      expect(startup).not.toHaveBeenCalled();
    });
  });

  describe.each(representativeCases)("$name selector forms", ({ args }) => {
    it.each([undefined, "work", " work "])(
      "preserves nonblank or omitted value %j",
      async (account) => {
        const { program, startup } = await createProgram(args);
        const argv = account === undefined ? args : [...args, "--account", account];
        await expect(program.parseAsync(argv, { from: "user" })).rejects.toThrow(
          "command startup reached",
        );
        expect(
          startup.mock.calls.map(([, action]) => action.opts<AccountOptions>().account),
        ).toEqual([account]);
        expect(startup.mock.calls.map(([, action]) => action.opts<AccountOptions>())).toEqual([
          expect.objectContaining({
            channel: "discord",
            json: true,
            ...(args[0] === "message" ? { dryRun: true, verbose: true } : {}),
          }),
        ]);
      },
    );

    it("rejects joined empty input before startup", async () => {
      const { program, startup } = await createProgram(args);
      await expect(program.parseAsync([...args, "--account="], { from: "user" })).rejects.toThrow(
        "--account must not be blank",
      );
      expect(startup).not.toHaveBeenCalled();
    });

    it("keeps the missing option argument error", async () => {
      const { program, startup } = await createProgram(args);
      await expect(program.parseAsync([...args, "--account"], { from: "user" })).rejects.toThrow(
        "argument missing",
      );
      expect(startup).not.toHaveBeenCalled();
    });
  });

  it.each([undefined, "work"])("keeps the missing resolve entry error for %j", async (account) => {
    const args = [
      "channels",
      "resolve",
      "--channel",
      "discord",
      ...(account === undefined ? [] : ["--account", account]),
    ];
    const { program, startup } = await createProgram(args);
    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
      "missing required argument",
    );
    expect(startup).not.toHaveBeenCalled();
  });

  it("reports a blank selector before a missing resolve entry", async () => {
    const args = ["channels", "resolve", "--account", ""];
    const { program, startup } = await createProgram(args);
    await expect(program.parseAsync(args, { from: "user" })).rejects.toThrow(
      "--account must not be blank",
    );
    expect(startup).not.toHaveBeenCalled();
  });
});
