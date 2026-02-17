import { describe, expect, it } from "vitest";
import { TelegramGroupSchema, TelegramTopicSchema } from "./zod-schema.providers-core.js";

describe("Telegram ingest schema", () => {
  it("accepts ingest in topic config", () => {
    const parsed = TelegramTopicSchema.parse({
      requireMention: true,
      ingest: true,
    });
    expect(parsed.ingest).toBe(true);
  });

  it("accepts ingest in group config", () => {
    const parsed = TelegramGroupSchema.parse({
      requireMention: true,
      ingest: true,
      topics: {
        "42": {
          ingest: false,
        },
      },
    });
    expect(parsed.ingest).toBe(true);
    expect(parsed.topics?.["42"]?.ingest).toBe(false);
  });
});
