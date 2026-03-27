import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createScopedAccountReplyToModeResolver,
  createStaticReplyToModeResolver,
  createTopLevelChannelReplyToModeResolver,
} from "./threading-helpers.js";

describe("createStaticReplyToModeResolver", () => {
  it("always returns the configured mode", () => {
    expect(createStaticReplyToModeResolver("off")({ cfg: {} as OpenClawConfig })).toBe("off");
    expect(createStaticReplyToModeResolver("all")({ cfg: {} as OpenClawConfig })).toBe("all");
  });
});

describe("createTopLevelChannelReplyToModeResolver", () => {
  it("reads the top-level channel config", () => {
    const resolver = createTopLevelChannelReplyToModeResolver("demo-top-level");
    expect(
      resolver({
        cfg: { channels: { "demo-top-level": { replyToMode: "first" } } } as OpenClawConfig,
      }),
    ).toBe("first");
  });

  it("falls back to off", () => {
    const resolver = createTopLevelChannelReplyToModeResolver("demo-top-level");
    expect(resolver({ cfg: {} as OpenClawConfig })).toBe("off");
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
