import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "./zod-schema.providers-core.js";

describe("telegram topic agentId schema", () => {
  it("accepts valid agentId in forum group topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              agentId: "main",
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
    expect(res.data.groups?.["-1001234567890"]?.topics?.["42"]?.agentId).toBe("main");
  });

  it("accepts valid agentId in DM topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      direct: {
        "123456789": {
          topics: {
            "99": {
              agentId: "support",
              systemPrompt: "You are support",
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
    expect(res.data.direct?.["123456789"]?.topics?.["99"]?.agentId).toBe("support");
  });

  it("accepts empty config without agentId (backward compatible)", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              systemPrompt: "Be helpful",
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
    expect(res.data.groups?.["-1001234567890"]?.topics?.["42"]).toEqual({
      systemPrompt: "Be helpful",
    });
  });

  it("accepts multiple topics with different agentIds", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "1": { agentId: "main" },
            "3": { agentId: "zu" },
            "5": { agentId: "q" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    const topics = res.data.groups?.["-1001234567890"]?.topics;
    expect(topics?.["1"]?.agentId).toBe("main");
    expect(topics?.["3"]?.agentId).toBe("zu");
    expect(topics?.["5"]?.agentId).toBe("q");
  });

  it("rejects unknown fields in topic config (strict schema)", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              agentId: "main",
              unknownField: "should fail",
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});

describe("telegram account agentId schema", () => {
  it("accepts agentId in telegram account config (multi-account routing)", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          accounts: {
            main: {
              botToken: "123:AAA",
              dmPolicy: "pairing",
              agentId: "main",
            },
            builder: {
              botToken: "456:BBB",
              dmPolicy: "pairing",
              agentId: "builder",
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
    expect(res.data.channels?.telegram?.accounts?.main?.agentId).toBe("main");
    expect(res.data.channels?.telegram?.accounts?.builder?.agentId).toBe("builder");
    expect(res.data.channels?.telegram?.accounts?.main?.botToken).toBe("123:AAA");
  });

  it("rejects top-level telegram agentId", () => {
    const res = OpenClawSchema.safeParse({
      channels: {
        telegram: {
          botToken: "123:AAA",
          dmPolicy: "pairing",
          agentId: "main",
        },
      },
    });

    expect(res.success).toBe(false);
  });
});

describe("telegram disableAudioPreflight schema", () => {
  it("accepts disableAudioPreflight for groups and topics", () => {
    const res = TelegramConfigSchema.safeParse({
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
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    const group = res.data.groups?.["*"];
    expect(group?.disableAudioPreflight).toBe(true);
    expect(group?.topics?.["123"]?.disableAudioPreflight).toBe(false);
  });

  it("rejects non-boolean disableAudioPreflight values", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "*": {
          disableAudioPreflight: "yes",
        },
      },
    });

    expect(res.success).toBe(false);
  });

  it("accepts telegram botToken without tokenFile", () => {
    const res = TelegramConfigSchema.safeParse({
      botToken: "123:ABC",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.botToken).toBe("123:ABC");
    expect(res.data.tokenFile).toBeUndefined();
  });

  it("accepts telegram tokenFile without botToken", () => {
    const res = TelegramConfigSchema.safeParse({
      tokenFile: "/run/agenix/telegram-token",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.tokenFile).toBe("/run/agenix/telegram-token");
    expect(res.data.botToken).toBeUndefined();
  });

  it("accepts telegram botToken and tokenFile together", () => {
    const res = TelegramConfigSchema.safeParse({
      botToken: "fallback:token",
      tokenFile: "/run/agenix/telegram-token",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.botToken).toBe("fallback:token");
    expect(res.data.tokenFile).toBe("/run/agenix/telegram-token");
  });
});
