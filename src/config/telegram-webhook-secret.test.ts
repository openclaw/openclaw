import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("Telegram webhook config", () => {
  it("accepts webhookUrl when webhookSecret is configured", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: "secret",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects webhookUrl without webhookSecret", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.telegram.webhookSecret");
    }
  });

  it("accepts account webhookUrl when base webhookSecret is configured", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookSecret: "secret",
          accounts: {
            ops: {
              webhookUrl: "https://example.com/telegram-webhook",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects account webhookUrl without webhookSecret", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          accounts: {
            ops: {
              webhookUrl: "https://example.com/telegram-webhook",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.telegram.accounts.ops.webhookSecret");
    }
  });
});
