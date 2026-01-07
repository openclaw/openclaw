import { Type } from "@sinclair/typebox";

import { createReactionSchema } from "./reaction-schema.js";

export const WhatsAppToolSchema = Type.Union([
  createReactionSchema({
    ids: {
      chatJid: Type.String(),
      messageId: Type.String(),
    },
    includeRemove: true,
    extras: {
      participant: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
      fromMe: Type.Optional(Type.Boolean()),
    },
  }),
]);
