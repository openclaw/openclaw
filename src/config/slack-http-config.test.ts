import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("Slack HTTP mode config", () => {
  it("accepts HTTP mode when signing secret is configured", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          mode: "http",
          signingSecret: "secret",
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts HTTP mode when signing secret is configured as SecretRef", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          mode: "http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects HTTP mode without signing secret", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          mode: "http",
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.slack.signingSecret");
    }
  });

  it("accepts account HTTP mode when base signing secret is set", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          signingSecret: "secret",
          accounts: {
            ops: {
              mode: "http",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("accepts account HTTP mode when account signing secret is set as SecretRef", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          accounts: {
            ops: {
              mode: "http",
              signingSecret: {
                source: "env",
                provider: "default",
                id: "SLACK_OPS_SIGNING_SECRET",
              },
            },
          },
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects account HTTP mode without signing secret", () => {
    const res = validateConfigObject({
      channels: {
        slack: {
          accounts: {
            ops: {
              mode: "http",
            },
          },
        },
      },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("channels.slack.accounts.ops.signingSecret");
    }
  });
});
