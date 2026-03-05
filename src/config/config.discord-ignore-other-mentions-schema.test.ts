import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("discord ignoreOtherMentions schema", () => {
  it("accepts ignoreOtherMentions for top-level guild and channel rules", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        discord: {
          guilds: {
            "1478741694391255140": {
              ignoreOtherMentions: true,
              channels: {
                "1478741694391255141": {
                  ignoreOtherMentions: true,
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }

    expect(res.data.channels?.discord?.guilds?.["1478741694391255140"]?.ignoreOtherMentions).toBe(
      true,
    );
    expect(
      res.data.channels?.discord?.guilds?.["1478741694391255140"]?.channels?.["1478741694391255141"]
        ?.ignoreOtherMentions,
    ).toBe(true);
  });

  it("accepts ignoreOtherMentions for account-scoped guild and channel rules", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        discord: {
          accounts: {
            vincent: {
              guilds: {
                "1478741694391255140": {
                  ignoreOtherMentions: true,
                  channels: {
                    "1478741694391255141": {
                      ignoreOtherMentions: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }

    expect(
      res.data.channels?.discord?.accounts?.vincent?.guilds?.["1478741694391255140"]
        ?.ignoreOtherMentions,
    ).toBe(true);
    expect(
      res.data.channels?.discord?.accounts?.vincent?.guilds?.["1478741694391255140"]?.channels?.[
        "1478741694391255141"
      ]?.ignoreOtherMentions,
    ).toBe(true);
  });
});
