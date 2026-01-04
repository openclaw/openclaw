import { Type } from "@sinclair/typebox";

export const SlackToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("react"),
    channelId: Type.String(),
    messageId: Type.String(),
    emoji: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("reactions"),
    channelId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("sendMessage"),
    to: Type.String(),
    content: Type.String(),
    mediaUrl: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("editMessage"),
    channelId: Type.String(),
    messageId: Type.String(),
    content: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("deleteMessage"),
    channelId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("readMessages"),
    channelId: Type.String(),
    limit: Type.Optional(Type.Number()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("pinMessage"),
    channelId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("unpinMessage"),
    channelId: Type.String(),
    messageId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("listPins"),
    channelId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("memberInfo"),
    userId: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("emojiList"),
  }),
]);
