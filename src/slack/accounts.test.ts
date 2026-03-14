import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSlackAccount } from "./accounts.js";

const ORIGINAL_SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;

afterEach(() => {
  if (ORIGINAL_SLACK_USER_TOKEN === undefined) {
    delete process.env.SLACK_USER_TOKEN;
    return;
  }
  process.env.SLACK_USER_TOKEN = ORIGINAL_SLACK_USER_TOKEN;
});

describe("resolveSlackAccount allowFrom precedence", () => {
  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("falls back to top-level dm.allowFrom when allowFrom alias is unset", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            dm: { allowFrom: ["U123"] },
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.dm?.allowFrom).toEqual(["U123"]);
  });
});

describe("resolveSlackAccount user token resolution", () => {
  it("uses SLACK_USER_TOKEN for default account when config userToken is missing", () => {
    process.env.SLACK_USER_TOKEN = " xoxp-env-token ";
    const cfg: OpenClawConfig = { channels: { slack: {} } };

    const account = resolveSlackAccount({ cfg });

    expect(account.userToken).toBe("xoxp-env-token");
    expect(account.userTokenSource).toBe("env");
  });

  it("prefers config userToken over SLACK_USER_TOKEN", () => {
    process.env.SLACK_USER_TOKEN = "xoxp-env-token";
    const cfg: OpenClawConfig = {
      channels: { slack: { userToken: "xoxp-config-token" } },
    };

    const account = resolveSlackAccount({ cfg });

    expect(account.userToken).toBe("xoxp-config-token");
    expect(account.userTokenSource).toBe("config");
  });

  it("does not apply SLACK_USER_TOKEN to non-default accounts", () => {
    process.env.SLACK_USER_TOKEN = "xoxp-env-token";
    const cfg: OpenClawConfig = {
      channels: { slack: { accounts: { work: {} } } },
    };

    const account = resolveSlackAccount({ cfg, accountId: "work" });

    expect(account.userToken).toBeUndefined();
    expect(account.userTokenSource).toBe("none");
  });
});
