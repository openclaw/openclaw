import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("account soulFile config validation", () => {
  it("accepts soulFile on supported multi-account channel providers", () => {
    const result = OpenClawSchema.safeParse({
      channels: {
        discord: {
          accounts: {
            work: { token: "discord-token", soulFile: "SOUL.discord.md" },
          },
        },
        slack: {
          accounts: {
            work: {
              botToken: "xoxb-1",
              appToken: "xapp-1",
              soulFile: "SOUL.slack.md",
            },
          },
        },
        signal: {
          accounts: {
            work: { account: "+15555550123", soulFile: "SOUL.signal.md" },
          },
        },
        imessage: {
          accounts: {
            work: { service: "imessage", soulFile: "SOUL.imessage.md" },
          },
        },
        whatsapp: {
          accounts: {
            work: { soulFile: "SOUL.whatsapp.md" },
          },
        },
      },
    });

    expect(result.success).toBe(true);
  });
});
