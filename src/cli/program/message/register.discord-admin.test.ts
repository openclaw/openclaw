import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { MessageCliHelpers } from "./helpers.js";
import { registerMessageDiscordAdminCommands } from "./register.discord-admin.js";

function createStubHelpers(): MessageCliHelpers {
  const identity = (cmd: Command) => cmd;
  const runMessageAction = vi.fn();
  return {
    withMessageBase: identity,
    withMessageTarget: identity,
    withRequiredMessageTarget: identity,
    runMessageAction,
  } as MessageCliHelpers;
}

function getSubcommandNames(parent: Command): string[] {
  return parent.commands.map((c) => c.name());
}

describe("registerMessageDiscordAdminCommands", () => {
  it("registers channel create/edit/delete/move subcommands", () => {
    const message = new Command("message");
    const helpers = createStubHelpers();
    registerMessageDiscordAdminCommands(message, helpers);

    const channel = message.commands.find((c) => c.name() === "channel");
    expect(channel).toBeDefined();

    const channelSubs = getSubcommandNames(channel!);
    expect(channelSubs).toContain("info");
    expect(channelSubs).toContain("list");
    expect(channelSubs).toContain("create");
    expect(channelSubs).toContain("edit");
    expect(channelSubs).toContain("delete");
    expect(channelSubs).toContain("move");
  });

  it("channel create requires --guild-id and --name", () => {
    const message = new Command("message");
    registerMessageDiscordAdminCommands(message, createStubHelpers());

    const channel = message.commands.find((c) => c.name() === "channel")!;
    const create = channel.commands.find((c) => c.name() === "create")!;
    const help = create.helpInformation();
    expect(help).toContain("--guild-id");
    expect(help).toContain("--name");
  });

  it("channel delete requires --channel-id", () => {
    const message = new Command("message");
    registerMessageDiscordAdminCommands(message, createStubHelpers());

    const channel = message.commands.find((c) => c.name() === "channel")!;
    const del = channel.commands.find((c) => c.name() === "delete")!;
    const help = del.helpInformation();
    expect(help).toContain("--channel-id");
  });

  it("channel move requires --guild-id and --channel-id", () => {
    const message = new Command("message");
    registerMessageDiscordAdminCommands(message, createStubHelpers());

    const channel = message.commands.find((c) => c.name() === "channel")!;
    const move = channel.commands.find((c) => c.name() === "move")!;
    const help = move.helpInformation();
    expect(help).toContain("--guild-id");
    expect(help).toContain("--channel-id");
  });
});
