import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveChannelDefaultAccountId } from "./helpers.js";
import type { ChannelPlugin } from "./types.js";

describe("resolveChannelDefaultAccountId", () => {
  it("falls back to the first configured account when plugin default is not listed", () => {
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["Primary"],
        defaultAccountId: () => "default",
      },
    } as unknown as ChannelPlugin;

    const accountId = resolveChannelDefaultAccountId({
      plugin,
      cfg: {} as OpenClawConfig,
    });

    expect(accountId).toBe("Primary");
  });

  it("keeps plugin default when it matches a listed account", () => {
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["default", "Primary"],
        defaultAccountId: () => "default",
      },
    } as unknown as ChannelPlugin;

    const accountId = resolveChannelDefaultAccountId({
      plugin,
      cfg: {} as OpenClawConfig,
    });

    expect(accountId).toBe("default");
  });
});
