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
});
