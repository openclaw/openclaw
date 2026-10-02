import { expect, it } from "vitest";
import { validateConfigObjectRaw } from "./validation-core.js";

it.each([
  [{ visibleReplies: true }, { visibleReplies: "automatic" }],
  [{ groupChat: { visibleReplies: false } }, { groupChat: { visibleReplies: "message_tool" } }],
])("normalizes boolean visible replies %#", (messages, expected) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: true,
    config: { messages: expected },
  });
});

it.each([
  [{ visibleReplies: "visible" }, "messages.visibleReplies"],
  [{ groupChat: { unmentionedInbound: true } }, "messages.groupChat.unmentionedInbound"],
])("rejects unsupported messages %j at %s", (messages, path) => {
  expect(validateConfigObjectRaw({ messages })).toMatchObject({
    ok: false,
    issues: expect.arrayContaining([expect.objectContaining({ path })]),
  });
});
