import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("telegram disableAudioPreflight schema", () => {
  it("accepts disableAudioPreflight for groups and topics", () => {
    const res = OpenClawSchema.safeParse({
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
    const res = OpenClawSchema.safeParse({
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

  it("accepts telegram botToken without tokenFile", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          botToken: "123:ABC",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.botToken).toBe("123:ABC");
    expect(res.data.channels?.telegram?.tokenFile).toBeUndefined();
  });

  it("accepts telegram tokenFile without botToken", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          tokenFile: "/run/agenix/telegram-token",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
    expect(res.data.channels?.telegram?.botToken).toBeUndefined();
  });

  it("accepts telegram botToken and tokenFile together", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          botToken: "fallback:token",
          tokenFile: "/run/agenix/telegram-token",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.channels?.telegram?.botToken).toBe("fallback:token");
    expect(res.data.channels?.telegram?.tokenFile).toBe("/run/agenix/telegram-token");
  });
});
