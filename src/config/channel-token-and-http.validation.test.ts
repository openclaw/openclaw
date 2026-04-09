import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("channel token and HTTP validation", () => {
  describe("Slack token fields", () => {
    it("accepts user token config fields", () => {
      const res = validateConfigObject({
        channels: {
          slack: {
            botToken: "xoxb-any",
            appToken: "xapp-any",
            userToken: "xoxp-any",
            userTokenReadOnly: false,
          },
        },
      });
      expect(res.ok).toBe(true);
    });

    it("accepts account-level user token config", () => {
      const res = validateConfigObject({
        channels: {
          slack: {
            accounts: {
              work: {
                botToken: "xoxb-any",
                appToken: "xapp-any",
                userToken: "xoxp-any",
                userTokenReadOnly: true,
              },
            },
          },
        },
      });
      expect(res.ok).toBe(true);
    });

    it("rejects invalid userTokenReadOnly types", () => {
      const res = validateConfigObject({
        channels: {
          slack: {
            botToken: "xoxb-any",
            appToken: "xapp-any",
            userToken: "xoxp-any",
            userTokenReadOnly: "no" as any,
          },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((iss) => iss.path.includes("userTokenReadOnly"))).toBe(true);
      }
    });

    it("rejects invalid userToken types", () => {
      const res = validateConfigObject({
        channels: {
          slack: {
            botToken: "xoxb-any",
            appToken: "xapp-any",
            userToken: 123 as any,
          },
        },
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((iss) => iss.path.includes("userToken"))).toBe(true);
      }
    });
  });

  describe("Slack HTTP mode", () => {
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
});
