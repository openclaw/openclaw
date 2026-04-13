import { describe, expect, it } from "vitest";
import { DiscordConfigSchema } from "./zod-schema.providers-core.js";

describe("discord agentComponents config", () => {
  it("accepts channels.discord.agentComponents.enabled", () => {
    const res = DiscordConfigSchema.safeParse({
      agentComponents: {
        enabled: true,
      },
    });

    expect(res.success).toBe(true);
  });

  it("accepts channels.discord.accounts.<id>.agentComponents.enabled", () => {
    const res = DiscordConfigSchema.safeParse({
      accounts: {
        work: {
          agentComponents: {
            enabled: false,
          },
        },
      },
    });

    expect(res.success).toBe(true);
  });

  it("rejects unknown fields under channels.discord.agentComponents", () => {
    const res = DiscordConfigSchema.safeParse({
      agentComponents: {
        enabled: true,
        invalidField: true,
      },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some(
          (issue) =>
            issue.path.join(".") === "agentComponents" &&
            issue.message.toLowerCase().includes("unrecognized"),
        ),
      ).toBe(true);
    }
  });
});
