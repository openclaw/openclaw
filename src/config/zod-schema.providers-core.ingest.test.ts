import { describe, expect, it } from "vitest";
import { TelegramGroupSchema, TelegramTopicSchema } from "./zod-schema.providers-core.js";

describe("ingest schema", () => {
  it("accepts telegram topic ingest boolean", () => {
    expect(TelegramTopicSchema.safeParse({ ingest: true }).success).toBe(true);
  });

  it("accepts telegram group ingest boolean", () => {
    expect(TelegramGroupSchema.safeParse({ ingest: true }).success).toBe(true);
  });

  it("rejects non-boolean ingest", () => {
    expect(TelegramGroupSchema.safeParse({ ingest: { enabled: true } }).success).toBe(false);
  });
});
