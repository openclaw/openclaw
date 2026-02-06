import { describe, expect, it } from "vitest";
import { InternalHooksSchema } from "./zod-schema.hooks.js";

describe("InternalHooksSchema", () => {
  it("accepts hook entries with extra fields like chance and file", () => {
    const input = {
      entries: {
        "soul-evil": {
          enabled: true,
          chance: 0.05,
          file: "custom-soul.md",
          purge: { at: "03:00", duration: "PT1H" },
        },
      },
    };
    const result = InternalHooksSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const entry = result.data?.entries?.["soul-evil"];
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).chance).toBe(0.05);
      expect((entry as Record<string, unknown>).file).toBe("custom-soul.md");
    }
  });

  it("still validates known fields in hook entries", () => {
    const input = {
      entries: {
        "my-hook": {
          enabled: "not-a-boolean",
        },
      },
    };
    const result = InternalHooksSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});
