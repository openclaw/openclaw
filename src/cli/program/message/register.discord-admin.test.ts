import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createMessageCliHelpers } from "./helpers.js";
import { registerMessageDiscordAdminCommands } from "./register.discord-admin.js";

type AdminCase = [
  command: string,
  action: string,
  required: Record<string, string>,
  optional?: Record<string, string>,
];

const cases: AdminCase[] = [
  ["role info", "role-info", { guildId: "guild-1" }],
  ["role add", "role-add", { guildId: "guild-1", userId: "user-1", roleId: "role-1" }],
  ["role remove", "role-remove", { guildId: "guild-1", userId: "user-1", roleId: "role-1" }],
  ["channel info", "channel-info", { target: "channel:123" }],
  ["channel list", "channel-list", { guildId: "guild-1" }],
  [
    "member info",
    "member-info",
    { userId: "user-1" },
    { guildId: "guild-1", channelId: "channel-1" },
  ],
  ["voice status", "voice-status", { guildId: "guild-1", userId: "user-1" }],
  ["event list", "event-list", { guildId: "guild-1" }],
  [
    "event create",
    "event-create",
    { guildId: "guild-1", eventName: "QA event", startTime: "2026-09-11T12:00:00Z" },
    {
      endTime: "2026-09-11T13:00:00Z",
      desc: "Event description",
      channelId: "channel-1",
      location: "QA room",
      eventType: "external",
      image: "https://example.com/event.png",
    },
  ],
  [
    "timeout",
    "timeout",
    { guildId: "guild-1", userId: "user-1" },
    { durationMin: "0", until: "2026-09-11T13:00:00Z", reason: "QA reason" },
  ],
  ["kick", "kick", { guildId: "guild-1", userId: "user-1" }, { reason: "QA reason" }],
  [
    "ban",
    "ban",
    { guildId: "guild-1", userId: "user-1" },
    { reason: "QA reason", deleteDays: "0" },
  ],
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
    ...createMessageCliHelpers("discord|matrix|msteams|slack"),
    runMessageAction,
  });
  return { command, runMessageAction };
}

describe("Discord-admin message registration", () => {
  it.each(cases)(
    "%s forwards the exact action, defaults and options",
    async (path, action, required, optional = {}) => {
      const { command, runMessageAction } = setup();
      const options = { ...required, ...optional, channel: "discord" };
      await command.parseAsync([...path.split(" "), ...argumentsFor(options)], { from: "user" });
      expect(runMessageAction).toHaveBeenCalledExactlyOnceWith(action, {
        json: false,
        dryRun: false,
        verbose: false,
        ...options,
      });
    },
  );

  it.each(cases)(
    "%s rejects every missing mandatory identifier before dispatch",
    async (path, _action, required) => {
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

  it("keeps guild and conversation optional for member info", async () => {
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
