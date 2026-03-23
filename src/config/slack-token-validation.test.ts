import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";

describe("Slack token config fields", () => {
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
          // oxlint-disable-next-line typescript/no-explicit-any
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
          // oxlint-disable-next-line typescript/no-explicit-any
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
