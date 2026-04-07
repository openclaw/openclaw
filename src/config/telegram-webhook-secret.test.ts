import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("Telegram webhook config", () => {
  it.each([
    {
      name: "webhookUrl when webhookSecret is configured",
      config: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: "secret",
        },
      },
    },
    {
      name: "webhookUrl when webhookSecret is configured as SecretRef",
      config: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: {
            source: "env",
            provider: "default",
            id: "TELEGRAM_WEBHOOK_SECRET",
          },
        },
      },
    },
    {
      name: "account webhookUrl when base webhookSecret is configured",
      config: {
        telegram: {
          webhookSecret: "secret",
          accounts: {
            ops: {
              webhookUrl: "https://example.com/telegram-webhook",
            },
          },
        },
      },
    },
    {
      name: "account webhookUrl when account webhookSecret is configured as SecretRef",
      config: {
        telegram: {
          accounts: {
            ops: {
              webhookUrl: "https://example.com/telegram-webhook",
              webhookSecret: {
                source: "env",
                provider: "default",
                id: "TELEGRAM_OPS_WEBHOOK_SECRET",
              },
            },
          },
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expect(validateConfigObject({ channels: config }).ok).toBe(true);
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
