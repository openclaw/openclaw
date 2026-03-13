import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";

describe("resolveDefaultChannelAccountContext", () => {
  it("uses enabled/configured defaults when hooks are missing", async () => {
    const account = { token: "x" };
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-1"],
        resolveAccount: () => account,
      },
    } as unknown as ChannelPlugin;

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig);

    expect(result.accountIds).toEqual(["acc-1"]);
    expect(result.defaultAccountId).toBe("acc-1");
    expect(result.account).toBe(account);
    expect(result.enabled).toBe(true);
    expect(result.configured).toBe(true);
  });

  it("uses plugin enable/configure hooks", async () => {
    const account = { enabled: false };
    const isEnabled = vi.fn(() => false);
    const isConfigured = vi.fn(async () => false);
    const plugin = {
      id: "demo",
      config: {
        listAccountIds: () => ["acc-2"],
        resolveAccount: () => account,
        isEnabled,
        isConfigured,
      },
    } as unknown as ChannelPlugin;

    const result = await resolveDefaultChannelAccountContext(plugin, {} as OpenClawConfig);

    expect(isEnabled).toHaveBeenCalledWith(account, {});
    expect(isConfigured).toHaveBeenCalledWith(account, {});
    expect(result.enabled).toBe(false);
    expect(result.configured).toBe(false);
  });
});
