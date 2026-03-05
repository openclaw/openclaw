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
});
