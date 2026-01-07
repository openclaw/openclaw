import { Type } from "@sinclair/typebox";

export const TelegramToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("react"),
    chatId: Type.Union([Type.String(), Type.Number()]),
    messageId: Type.Union([Type.String(), Type.Number()]),
    emoji: Type.String(),
    remove: Type.Optional(Type.Boolean()),
  }),
]);
