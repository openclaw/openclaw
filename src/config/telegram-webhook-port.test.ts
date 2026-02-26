import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("Telegram webhookPort config", () => {
  it("accepts a positive webhookPort", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: "secret",
          webhookPort: 8787,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts webhookPort set to 0 for ephemeral port binding", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: "secret",
          webhookPort: 0,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects negative webhookPort", () => {
    const res = validateConfigObject({
      channels: {
        telegram: {
          webhookUrl: "https://example.com/telegram-webhook",
          webhookSecret: "secret",
          webhookPort: -1,
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((issue) => issue.path === "channels.telegram.webhookPort")).toBe(true);
    }
  });
});
