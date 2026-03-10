import { describe, expect, it } from "vitest";
import { resolveDiscordAccount, resolveDiscordMaxLinesPerMessage } from "./accounts.js";

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

describe("resolveDiscordMaxLinesPerMessage", () => {
  it("falls back to merged root discord maxLinesPerMessage when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default" },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "default",
    });

    expect(resolved).toBe(120);
  });

  it("prefers explicit runtime discord maxLinesPerMessage over merged config", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              default: { token: "token-default", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: { maxLinesPerMessage: 55 },
      accountId: "default",
    });

    expect(resolved).toBe(55);
  });

  it("uses per-account discord maxLinesPerMessage over the root value when runtime config omits it", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            maxLinesPerMessage: 120,
            accounts: {
              work: { token: "token-work", maxLinesPerMessage: 80 },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "work",
    });

    expect(resolved).toBe(80);
  });

  it("returns undefined when no maxLinesPerMessage is configured anywhere", () => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { token: "token-default" },
            },
          },
        },
      },
      discordConfig: {},
      accountId: "default",
    });

    expect(resolved).toBeUndefined();
  });

  // Regression test for #42224
  it("correctly resolves maxLinesPerMessage when passed through provider flow", () => {
    // Simulate the provider flow: resolveDiscordAccount -> account.config
    const cfg = {
      channels: {
        discord: {
          maxLinesPerMessage: 100,
          textChunkLimit: 2000,
          blockStreaming: true,
          streaming: "off" as const,
        },
      },
    };

    // This is what provider.ts does
    const account = resolveDiscordAccount({ cfg, accountId: "default" });
    const discordCfg = account.config;

    // This is what message-handler.process.ts does
    const maxLinesPerMessage = resolveDiscordMaxLinesPerMessage({
      cfg,
      discordConfig: discordCfg,
      accountId: "default",
    });

    expect(maxLinesPerMessage).toBe(100);
  });
});
