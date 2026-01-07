import { Type } from "@sinclair/typebox";

export const WhatsAppToolSchema = Type.Union([
  Type.Object({
    action: Type.Literal("react"),
    chatJid: Type.String(),
    messageId: Type.String(),
    emoji: Type.String(),
    participant: Type.Optional(Type.String()),
  }),
]);
