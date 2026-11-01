import { describe, expect, it } from "vitest";
import { createMessageCliProgram, messageCliMocks } from "./command.test-support.js";

type Options = Record<string, string>;
type AdminCase = [string, string, Options, Options?, Record<string, unknown>?];

const guild = { guildId: "guild-1" };
const member = { ...guild, userId: "user-1" };
const baseOptions = { json: false, dryRun: false, verbose: false, accountId: undefined };
const cases: AdminCase[] = [
  [
    "edit",
    "edit",
    { messageId: "message-1", message: "updated", target: "channel:123" },
    { threadId: "thread-1" },
  ],
  ["delete", "delete", { messageId: "message-1", target: "channel:123" }],
  ["thread list", "thread-list", guild, { channelId: "channel-1" }, { includeArchived: false }],
  [
    "thread reply",
    "thread-reply",
    { message: "reply", target: "thread-1" },
    { media: "https://example.com/image.png", replyTo: "message-1" },
  ],
  [
    "emoji upload",
    "emoji-upload",
    { ...guild, emojiName: "party", media: "https://example.com/emoji.png" },
    {},
    { roleIds: [] },
  ],
  [
    "sticker upload",
    "sticker-upload",
    {
      ...guild,
      stickerName: "party",
      stickerDesc: "Party sticker",
      stickerTags: "party",
      media: "https://example.com/sticker.png",
    },
  ],
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

function run(path: string, options: Options) {
  messageCliMocks.command.mockClear();
  const args = Object.entries(options).flatMap(([key, value]) => [
    "--" + key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase()),
    value,
  ]);
  return createMessageCliProgram().parseAsync(["message", ...path.split(" "), ...args], {
    from: "user",
  });
}

function expectAction(action: string, options: Options, defaults: Record<string, unknown> = {}) {
  expect(messageCliMocks.command).toHaveBeenCalledExactlyOnceWith(
    { ...baseOptions, ...defaults, ...options, action },
    expect.anything(),
    expect.anything(),
  );
}

describe("message action registration", () => {
  it.each(cases)(
    "%s forwards the exact action, defaults and options",
    async (path, action, required, optional = {}, defaults = {}) => {
      const options = { ...required, ...optional, channel: "discord" };
      await run(path, options);
      expectAction(action, options, defaults);
    },
  );

  it.each(cases)(
    "%s rejects every missing mandatory identifier before dispatch",
    async (path, _action, required) => {
      for (const missing of Object.keys(required)) {
        const remaining = { ...required };
        delete remaining[missing];
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
