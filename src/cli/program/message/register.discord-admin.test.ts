import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createMessageCliHelpers } from "./helpers.js";
import { registerMessageDiscordAdminCommands } from "./register.discord-admin.js";

type AdminCase = {
  command: string;
  action: string;
  required: Record<string, string>;
  optional?: Record<string, string>;
};

const cases: AdminCase[] = [
  { command: "role info", action: "role-info", required: { guildId: "guild-1" } },
  {
    command: "role add",
    action: "role-add",
    required: { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
  },
  {
    command: "role remove",
    action: "role-remove",
    required: { guildId: "guild-1", userId: "user-1", roleId: "role-1" },
  },
  { command: "channel info", action: "channel-info", required: { target: "channel:123" } },
  { command: "channel list", action: "channel-list", required: { guildId: "guild-1" } },
  {
    command: "member info",
    action: "member-info",
    required: { userId: "user-1" },
    optional: { guildId: "guild-1" },
  },
  {
    command: "voice status",
    action: "voice-status",
    required: { guildId: "guild-1", userId: "user-1" },
  },
  { command: "event list", action: "event-list", required: { guildId: "guild-1" } },
  {
    command: "event create",
    action: "event-create",
    required: { guildId: "guild-1", eventName: "QA event", startTime: "2026-09-11T12:00:00Z" },
    optional: {
      endTime: "2026-09-11T13:00:00Z",
      desc: "Event description",
      channelId: "channel-1",
      location: "QA room",
      eventType: "external",
      image: "https://example.com/event.png",
    },
  },
  {
    command: "timeout",
    action: "timeout",
    required: { guildId: "guild-1", userId: "user-1" },
    optional: { durationMin: "0", until: "2026-09-11T13:00:00Z", reason: "QA reason" },
  },
  {
    command: "kick",
    action: "kick",
    required: { guildId: "guild-1", userId: "user-1" },
    optional: { reason: "QA reason" },
  },
  {
    command: "ban",
    action: "ban",
    required: { guildId: "guild-1", userId: "user-1" },
    optional: { reason: "QA reason", deleteDays: "0" },
  },
];

function flag(key: string) {
  return "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}

function argumentsFor(options: Record<string, string>) {
  return Object.entries(options).flatMap(([key, value]) => [flag(key), value]);
}

function setup() {
  const command = new Command()
    .name("message")
    .exitOverride()
    .configureOutput({ writeErr() {}, writeOut() {} });
  const runMessageAction = vi.fn(async () => {});
  registerMessageDiscordAdminCommands(command, {
    ...createMessageCliHelpers("discord"),
    runMessageAction,
  });
  return { command, runMessageAction };
}

function leaf(command: Command, path: string) {
  let current = command;
  for (const name of path.split(" ")) {
    const next = current.commands.find((candidate) => candidate.name() === name);
    if (!next) {
      throw new Error("Missing command " + path);
    }
    current = next;
  }
  return current;
}

describe("Discord-admin message registration", () => {
  it.each(cases)(
    "$command forwards the exact action, defaults and options",
    async ({ command: path, action, required, optional = {} }) => {
      const { command, runMessageAction } = setup();
      await command.parseAsync(
        [
          ...path.split(" "),
          ...argumentsFor(required),
          ...argumentsFor(optional),
          "--channel",
          "discord",
        ],
        { from: "user" },
      );
      expect(runMessageAction).toHaveBeenCalledExactlyOnceWith(action, {
        json: false,
        dryRun: false,
        verbose: false,
        ...required,
        ...optional,
        channel: "discord",
      });
    },
  );

  it.each(cases)(
    "$command rejects every missing mandatory identifier before dispatch",
    async ({ command: path, required }) => {
      for (const missing of Object.keys(required)) {
        const { command, runMessageAction } = setup();
        const remaining = Object.fromEntries(
          Object.entries(required).filter(([key]) => key !== missing),
        );
        await expect(
          command.parseAsync([...path.split(" "), ...argumentsFor(remaining)], { from: "user" }),
        ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
        expect(runMessageAction).not.toHaveBeenCalled();
      }
    },
  );

  it.each(cases)(
    "$command keeps required, shared and leaf-only flags in help order",
    ({ command: path, required, optional = {} }) => {
      const { command } = setup();
      expect(leaf(command, path).options.map((option) => option.long)).toEqual([
        ...Object.keys(required).map(flag),
        "--channel",
        "--account",
        "--json",
        "--dry-run",
        "--verbose",
        ...Object.keys(optional).map(flag),
      ]);
    },
  );

  it("keeps guild optional for member info", async () => {
    const { command, runMessageAction } = setup();
    await command.parseAsync(["member", "info", "--user-id", "user-1"], { from: "user" });
    expect(runMessageAction).toHaveBeenCalledExactlyOnceWith("member-info", {
      json: false,
      dryRun: false,
      verbose: false,
      userId: "user-1",
    });
  });
});
