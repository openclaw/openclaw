import { describe, it, expect } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveChannelAccountConfigBasePath } from "./config-paths.js";

describe("resolveChannelAccountConfigBasePath", () => {
  it("returns channel-root path when no accounts section exists", () => {
    const cfg = {
      channels: { telegram: { botToken: "abc" } },
    } as unknown as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "telegram",
      accountId: "default",
    });
    expect(result).toBe("channels.telegram.");
  });

  it("returns channel-root path when accountId is not present in accounts", () => {
    const cfg = {
      channels: { telegram: { botToken: "abc", accounts: { secondary: { botToken: "xyz" } } } },
    } as unknown as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "telegram",
      accountId: "default",
    });
    expect(result).toBe("channels.telegram.");
  });

  it("returns per-account path when accountId is present in accounts", () => {
    const cfg = {
      channels: { telegram: { accounts: { secondary: { botToken: "xyz" } } } },
    } as unknown as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "telegram",
      accountId: "secondary",
    });
    expect(result).toBe("channels.telegram.accounts.secondary.");
  });

  it("handles hyphenated channel keys like nextcloud-talk", () => {
    const cfg = {
      channels: { "nextcloud-talk": { accounts: { mybot: { botSecret: "s" } } } },
    } as unknown as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "nextcloud-talk",
      accountId: "mybot",
    });
    expect(result).toBe("channels.nextcloud-talk.accounts.mybot.");
  });

  it("returns channel-root path when channels section is absent", () => {
    const cfg = {} as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "signal",
      accountId: "default",
    });
    expect(result).toBe("channels.signal.");
  });

  it("path ends with a trailing dot for correct consumer concatenation", () => {
    const cfg = {} as OpenClawConfig;
    const basePath = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "slack",
      accountId: "default",
    });
    // Consumer builds: `${basePath}dmPolicy` and `${basePath}allowFrom`
    expect(basePath.endsWith(".")).toBe(true);
    expect(`${basePath}dmPolicy`).toBe("channels.slack.dmPolicy");
    expect(`${basePath}allowFrom`).toBe("channels.slack.allowFrom");
  });

  it("per-account path ends with trailing dot", () => {
    const cfg = {
      channels: { discord: { accounts: { bot2: {} } } },
    } as unknown as OpenClawConfig;
    const basePath = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "discord",
      accountId: "bot2",
    });
    expect(basePath.endsWith(".")).toBe(true);
    expect(`${basePath}dm.allowFrom`).toBe("channels.discord.accounts.bot2.dm.allowFrom");
  });

  it("returns channel-root path when accountId entry is null (falsy guard)", () => {
    // Boolean(null) is false — null entry should not trigger per-account path
    const cfg = {
      channels: { telegram: { accounts: { orphan: null } } },
    } as unknown as OpenClawConfig;
    const result = resolveChannelAccountConfigBasePath({
      cfg,
      channelKey: "telegram",
      accountId: "orphan",
    });
    expect(result).toBe("channels.telegram.");
  });
});
