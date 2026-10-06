import { describe, expect, it, vi } from "vitest";

const pluginRegistry = vi.hoisted(() => ({ list: [] as unknown[] }));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => pluginRegistry.list,
}));

vi.mock("../channels/read-only-account-inspect.js", () => ({
  inspectReadOnlyChannelAccount: () => undefined,
}));

import { resolveLinkChannelContext } from "../status/link-channel.js";

describe("resolveLinkChannelContext", () => {
  it("returns linked context from read-only inspected account state", async () => {
    const account = { configured: true, enabled: true, linked: true };
    pluginRegistry.list = [
      {
        id: "quietchat",
        meta: { label: "QuietChat" },
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: () => account,
          resolveAccount: () => {
            throw new Error("should not be called in read-only mode");
          },
        },
        status: {
          buildChannelSummary: () => {
            throw new Error("runtime summary must not receive inspection metadata");
          },
        },
      },
    ];

    const result = await resolveLinkChannelContext({});
    expect(result?.linked).toBe(true);
    expect(result?.authAgeMs).toBeNull();
    expect(result?.account).toBe(account);
  });
});
