import { describe, expect, it } from "vitest";
import { resolveDiscordAccount } from "./accounts.js";

describe("resolveDiscordAccount allowFrom precedence", () => {
  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            allowFrom: ["top"],
            accounts: {
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("inherits top-level guilds when account allowlist mode overrides with empty guilds", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  "456": { allow: true },
                },
              },
            },
            accounts: {
              default: {
                token: "token-default",
                groupPolicy: "allowlist",
                guilds: {},
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(Object.keys(resolved.config.guilds ?? {})).toEqual(["123"]);
    expect(resolved.config.guilds?.["123"]?.channels?.["456"]?.allow).toBe(true);
  });

  it("keeps explicit empty guild override when account groupPolicy is not allowlist", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            groupPolicy: "allowlist",
            guilds: {
              "123": {
                channels: {
                  "456": { allow: true },
                },
              },
            },
            accounts: {
              default: {
                token: "token-default",
                groupPolicy: "open",
                guilds: {},
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.guilds).toEqual({});
  });
});
