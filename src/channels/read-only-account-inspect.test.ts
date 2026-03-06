import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { inspectReadOnlyChannelAccount } from "./read-only-account-inspect.js";

const emptyConfig = {} as OpenClawConfig;

describe("inspectReadOnlyChannelAccount", () => {
  it("returns null for unknown channel ids", () => {
    expect(
      inspectReadOnlyChannelAccount({
        channelId: "msteams" as never,
        cfg: emptyConfig,
      }),
    ).toBeNull();
  });

  it("dispatches to discord for discord channel id", () => {
    const result = inspectReadOnlyChannelAccount({
      channelId: "discord",
      cfg: emptyConfig,
    });
    expect(result).not.toBeNull();
    expect(result?.accountId).toBeDefined();
  });

  it("dispatches to slack for slack channel id", () => {
    const result = inspectReadOnlyChannelAccount({
      channelId: "slack",
      cfg: emptyConfig,
    });
    expect(result).not.toBeNull();
    expect(result?.accountId).toBeDefined();
  });

  it("dispatches to telegram for telegram channel id", () => {
    const result = inspectReadOnlyChannelAccount({
      channelId: "telegram",
      cfg: emptyConfig,
    });
    expect(result).not.toBeNull();
    expect(result?.accountId).toBeDefined();
  });

  it("passes accountId to channel inspection", () => {
    const result = inspectReadOnlyChannelAccount({
      channelId: "discord",
      cfg: emptyConfig,
      accountId: "secondary",
    });
    expect(result?.accountId).toBe("secondary");
  });

  it("handles null accountId by using the default account", () => {
    const result = inspectReadOnlyChannelAccount({
      channelId: "discord",
      cfg: emptyConfig,
      accountId: null,
    });
    expect(result?.accountId).toBeDefined();
  });
});
