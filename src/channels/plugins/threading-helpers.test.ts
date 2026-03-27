import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createScopedAccountReplyToModeResolver,
  createStaticReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "./threading-helpers.js";

describe("createStaticReplyToModeResolver", () => {
  it.each(["off", "all"] as const)("always returns the configured mode %s", (mode) => {
    expect(createStaticReplyToModeResolver(mode)({ cfg: {} as OpenClawConfig })).toBe(mode);
  });
});

describe("createTopLevelChannelReplyToModeResolver", () => {
  const resolver = createTopLevelChannelReplyToModeResolver("demo-top-level");

  it.each([
    {
      name: "reads the top-level channel config",
      cfg: { channels: { "demo-top-level": { replyToMode: "first" } } } as OpenClawConfig,
      expected: "first",
    },
    {
      name: "falls back to off",
      cfg: {} as OpenClawConfig,
      expected: "off",
    },
  ])("$name", ({ cfg, expected }) => {
    expect(resolver({ cfg })).toBe(expected);
  });
});

describe("createScopedAccountReplyToModeResolver", () => {
  it("reads the scoped account reply mode", () => {
    const resolver = createScopedAccountReplyToModeResolver({
      resolveAccount: (cfg, accountId) =>
        ((
          cfg.channels as {
            demo?: { accounts?: Record<string, { replyToMode?: "off" | "first" | "all" }> };
          }
        ).demo?.accounts?.[accountId?.toLowerCase() ?? "default"] ?? {}) as {
          replyToMode?: "off" | "first" | "all";
        },
      resolveReplyToMode: (account) => account.replyToMode,
    });

    const cfg = {
      channels: {
        demo: {
          accounts: {
            assistant: { replyToMode: "all" },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolver({ cfg, accountId: "assistant" })).toBe("all");
    expect(resolver({ cfg, accountId: "default" })).toBe("off");
  });

  it("passes chatType through", () => {
    const seen: Array<string | null | undefined> = [];
    const resolver = createScopedAccountReplyToModeResolver({
      resolveAccount: () => ({ replyToMode: "first" as const }),
      resolveReplyToMode: (account, chatType) => {
        seen.push(chatType);
        return account.replyToMode;
      },
    });

    expect(resolver({ cfg: {} as OpenClawConfig, chatType: "group" })).toBe("first");
    expect(seen).toEqual(["group"]);
  });
});
