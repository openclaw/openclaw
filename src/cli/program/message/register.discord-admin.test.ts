import { describe, expect, it } from "vitest";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

type Options = Record<string, string>;
type AdminCase = [command: string, action: string, required: Options, optional?: Options];

const guild = { guildId: "guild-1" };
const member = { ...guild, userId: "user-1" };
const cases: AdminCase[] = [
  ["role info", "role-info", guild],
  ["role add", "role-add", { ...member, roleId: "role-1" }],
  ["role remove", "role-remove", { ...member, roleId: "role-1" }],
  ["channel info", "channel-info", { target: "channel:123" }],
  ["channel list", "channel-list", guild],
  ["member info", "member-info", { userId: "user-1" }, { ...guild, channelId: "channel-1" }],
  ["voice status", "voice-status", member],
  ["event list", "event-list", guild],
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
    member,
    { durationMin: "0", until: "2026-09-11T13:00:00Z", reason: "QA reason" },
  ],
  ["kick", "kick", member, { reason: "QA reason" }],
  ["ban", "ban", member, { reason: "QA reason", deleteDays: "0" }],
];

function flag(key: string) {
  return "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
}

function argumentsFor(options: Options) {
  return Object.entries(options).flatMap(([key, value]) => [flag(key), value]);
}

function run(path: string, options: Options) {
  messageCliMocks.command.mockClear();
  return createMessageCliProgram().parseAsync(
    ["message", ...path.split(" "), ...argumentsFor(options)],
    { from: "user" },
  );
}

function expectAction(action: string, options: Options) {
  expect(messageCliMocks.command).toHaveBeenCalledExactlyOnceWith(
    { json: false, dryRun: false, verbose: false, ...options, accountId: undefined, action },
    expect.anything(),
    expect.anything(),
  );
}

describe("Discord-admin message registration", () => {
  it.each(cases)(
    "%s forwards the exact action, defaults and options",
    async (path, action, required, optional = {}) => {
      const options = { ...required, ...optional, channel: "discord" };
      await run(path, options);
      expectAction(action, options);
    },
  );

  it.each(cases)(
    "%s rejects every missing mandatory identifier before dispatch",
    async (path, _action, required) => {
      for (const missing of Object.keys(required)) {
        const remaining = Object.fromEntries(
          Object.entries(required).filter(([key]) => key !== missing),
        );
        await expect(run(path, remaining)).rejects.toMatchObject({
          code: "commander.missingMandatoryOptionValue",
        });
        expect(messageCliMocks.command).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps guild and conversation optional for member info", async () => {
    await run("member info", { userId: "user-1" });
    expectAction("member-info", { userId: "user-1" });
  });
});
