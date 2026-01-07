import { Type } from "@sinclair/typebox";

export const WhatsAppToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("react"),
    chatJid: Type.String(),
    messageId: Type.String(),
    emoji: Type.String(),
    remove: Type.Optional(Type.Boolean()),
    participant: Type.Optional(Type.String()),
    accountId: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
  }),
]);
