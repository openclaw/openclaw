import { describe, expect, it } from "vitest";
import { MullusiSchema } from "./zod-schema.js";

describe("telegram disableAudioPreflight schema", () => {
  it("accepts disableAudioPreflight for groups and topics", () => {
    const res = MullusiSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "*": {
              requireMention: true,
              disableAudioPreflight: true,
              topics: {
                "123": {
                  disableAudioPreflight: false,
                },
              },
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    const group = res.data.channels?.telegram?.groups?.["*"];
    expect(group?.disableAudioPreflight).toBe(true);
    expect(group?.topics?.["123"]?.disableAudioPreflight).toBe(false);
  });

  it("rejects non-boolean disableAudioPreflight values", () => {
    const res = MullusiSchema.safeParse({
      channels: {
        telegram: {
          groups: {
            "*": {
              disableAudioPreflight: "yes",
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});
