import { Type } from "@sinclair/typebox";

import { createReactionSchema } from "./reaction-schema.js";

export const TelegramToolSchema = Type.Union([
  createReactionSchema({
    ids: {
      chatId: Type.Union([Type.String(), Type.Number()]),
      messageId: Type.Union([Type.String(), Type.Number()]),
    },
    includeRemove: true,
  }),
]);
