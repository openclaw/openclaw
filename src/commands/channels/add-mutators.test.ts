import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { applyChannelAccountConfig } from "./add-mutators.js";

describe("applyChannelAccountConfig", () => {
  it("normalizes official external compatibility output before non-interactive writes", () => {
    const plugin = {
      setup: {
        applyAccountConfig: ({ cfg }: { cfg: Record<string, unknown> }) => ({
          ...cfg,
          channels: {
            qqbot: {
              appId: "app-id",
              clientSecret: "secret",
              allowFrom: ["*"],
            },
          },
        }),
      },
    } as unknown as ChannelPlugin;

    const next = applyChannelAccountConfig({
      cfg: {},
      channel: "qqbot",
      accountId: "default",
      input: {},
      plugin,
    });

    expect(next.channels?.qqbot).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["openclaw:approval-disabled"],
    });
  });
});
