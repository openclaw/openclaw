import { describe, expect, it } from "vitest";
import { BotSchema } from "./zod-schema.js";

describe("telegram custom commands schema", () => {
  it("normalizes custom commands", () => {
    const res = BotSchema.safeParse({
      channels: {
        telegram: {
          customCommands: [{ command: "/Backup", description: "  Git backup  " }],
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.customCommands).toEqual([
      { command: "backup", description: "Git backup" },
    ]);
  });

  it("normalizes hyphens in custom command names", () => {
    const res = BotSchema.safeParse({
      channels: {
        telegram: {
          customCommands: [{ command: "Bad-Name", description: "Override status" }],
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.customCommands).toEqual([
      { command: "bad_name", description: "Override status" },
    ]);
  });
});
