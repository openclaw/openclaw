import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  enforceOutboundAllowlist,
  enforceOutboundAllowlistAsync,
} from "./send.outbound-allowlist.js";
import { DiscordSendError } from "./send.types.js";

function makeCfg(overrides: {
  groupPolicy?: "open" | "disabled" | "allowlist";
  defaultGroupPolicy?: "open" | "disabled" | "allowlist";
  guilds?: Record<string, unknown>;
}): OpenClawConfig {
  return {
    channels: {
      defaults: overrides.defaultGroupPolicy
        ? { groupPolicy: overrides.defaultGroupPolicy }
        : undefined,
      discord: {
        groupPolicy: overrides.groupPolicy,
        guilds: overrides.guilds as OpenClawConfig["channels"] extends { discord?: infer D }
          ? D extends { guilds?: infer G }
            ? G
            : never
          : never,
      },
    },
  } as OpenClawConfig;
}

describe("enforceOutboundAllowlist", () => {
  // 1. DM bypass
  it("allows DMs without checking allowlist", () => {
    const cfg = makeCfg({ groupPolicy: "disabled" });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "dm-channel",
        isDm: true,
      }),
    ).not.toThrow();
  });

  // 2. Open policy
  it("allows all sends when groupPolicy is open", () => {
    const cfg = makeCfg({ groupPolicy: "open" });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "any-channel",
        guildId: "any-guild",
      }),
    ).not.toThrow();
  });

  // 3. Disabled policy
  it("blocks all sends when groupPolicy is disabled", () => {
    const cfg = makeCfg({ groupPolicy: "disabled" });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "any-channel",
        guildId: "any-guild",
      }),
    ).toThrow(DiscordSendError);
  });

  // 4. Allowlist: guild in config, channel in allowlist
  it("allows sends to channels in the allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "chan-1": { allow: true },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "guild-1",
      }),
    ).not.toThrow();
  });

  // 5. Allowlist: guild in config, channel NOT in allowlist
  it("blocks sends to channels not in the allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "chan-1": { allow: true },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-other",
        guildId: "guild-1",
      }),
    ).toThrow(DiscordSendError);
  });

  // 6. Allowlist: guild NOT in config
  it("blocks sends to guilds not in the allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "guild-unknown",
      }),
    ).toThrow(DiscordSendError);
  });

  // 7. Allowlist: guild in config, no channels defined (guild-level allow)
  it("allows sends when guild is in config but has no channel restrictions", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {},
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "any-channel",
        guildId: "guild-1",
      }),
    ).not.toThrow();
  });

  // 8. Allowlist: wildcard guild "*"
  it("allows sends when wildcard guild entry exists", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "any-guild",
      }),
    ).not.toThrow();
  });

  // 9. Allowlist: wildcard channel "*" in guild
  it("allows sends when wildcard channel entry exists in guild", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: { "*": { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "any-channel",
        guildId: "guild-1",
      }),
    ).not.toThrow();
  });

  it("allows sends when channel key is slug and channelName is provided", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: { general: { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-123",
        channelName: "General",
        guildId: "guild-1",
      }),
    ).not.toThrow();
  });

  // 10. Channel enabled: false
  it("blocks sends when channel is explicitly disabled", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "chan-1": { allow: true, enabled: false },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "guild-1",
      }),
    ).toThrow(DiscordSendError);
  });

  // 11. Channel allow: false
  it("blocks sends when channel has allow: false", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "chan-1": { allow: false },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "guild-1",
      }),
    ).toThrow(DiscordSendError);
  });

  // 12. No guildId + not DM (with allowlist policy — open policy doesn't need guildId)
  it("blocks sends when guildId is missing for non-DM with allowlist policy", () => {
    const cfg = makeCfg({ groupPolicy: "allowlist" });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        isDm: false,
      }),
    ).toThrow(DiscordSendError);
  });

  // 13. Error kind is "outbound-blocked" on all blocked cases
  it("sets error kind to outbound-blocked on policy blocks", () => {
    const cfg = makeCfg({ groupPolicy: "disabled" });
    try {
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "guild-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordSendError);
      expect((err as DiscordSendError).kind).toBe("outbound-blocked");
    }
  });

  it("sets error kind to outbound-blocked when channel not in allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    try {
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-other",
        guildId: "guild-1",
      });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(DiscordSendError);
      expect((err as DiscordSendError).kind).toBe("outbound-blocked");
    }
  });

  // 14. Thread with parent in allowlist
  it("allows thread sends when parent channel is in allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "parent-chan": { allow: true },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "thread-123",
        guildId: "guild-1",
        isThread: true,
        parentChannelId: "parent-chan",
      }),
    ).not.toThrow();
  });

  // 15. Thread with parent NOT in allowlist
  it("blocks thread sends when parent channel is not in allowlist", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            "other-chan": { allow: true },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "thread-123",
        guildId: "guild-1",
        parentChannelId: "parent-not-allowed",
      }),
    ).toThrow(DiscordSendError);
  });

  it("allows thread sends when parent channel slug is allowlisted", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "guild-1": {
          channels: {
            general: { allow: true },
          },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "thread-123",
        channelName: "Thread name",
        guildId: "guild-1",
        isThread: true,
        parentChannelId: "parent-id",
        parentChannelName: "General",
      }),
    ).not.toThrow();
  });

  // 16. Default policy resolution — no groupPolicy set anywhere → falls back to "open"
  it("defaults to open policy when no groupPolicy is configured", () => {
    const cfg = makeCfg({});
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "any-channel",
        guildId: "any-guild",
      }),
    ).not.toThrow();
  });

  // Slug-keyed guild with guildName provided
  it("matches slug-keyed guild entries when guildName is provided", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "my-cool-server": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "12345",
        guildName: "My Cool Server",
      }),
    ).not.toThrow();
  });

  // Slug-keyed guild without guildName → blocked
  it("blocks when slug-keyed guild exists but no guildName to resolve", () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "my-cool-server": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    expect(() =>
      enforceOutboundAllowlist({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "12345",
      }),
    ).toThrow(DiscordSendError);
  });

  it("async enforcement resolves slug-keyed guilds by fetching guild name", async () => {
    const cfg = makeCfg({
      groupPolicy: "allowlist",
      guilds: {
        "my-cool-server": {
          channels: { "chan-1": { allow: true } },
        },
      },
    });
    const rest = {
      get: async (path: string) => {
        if (path === "/guilds/12345") {
          return { name: "My Cool Server" };
        }
        throw new Error(`Unexpected path: ${path}`);
      },
    };
    await expect(
      enforceOutboundAllowlistAsync({
        cfg,
        accountId: "default",
        channelId: "chan-1",
        guildId: "12345",
        rest: rest as never,
      }),
    ).resolves.toBeUndefined();
  });
});
