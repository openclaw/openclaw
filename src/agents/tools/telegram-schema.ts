import { Type } from "@sinclair/typebox";

import { createReactionSchema } from "./reaction-schema.js";

// NOTE: chatId and messageId use Type.String() instead of Type.Union([Type.String(), Type.Number()])
// because nested anyOf schemas cause JSON Schema validation failures with Claude API on Vertex AI.
// Telegram IDs are coerced to strings at runtime in telegram-actions.ts.
export const TelegramToolSchema = Type.Union([
  createReactionSchema({
    ids: {
      chatId: Type.String(),
      messageId: Type.String(),
    },
    includeRemove: true,
  }),
]);
