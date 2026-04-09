import { describe, expect, it } from "vitest";
          contextVisibility: "allowlist_quote",
        },
        slack: {
          contextVisibility: "allowlist",
          accounts: {
            work: {
              contextVisibility: "all",
            },
          },
        },
      },
    } satisfies OpenClawConfig;
    expect(
      resolveChannelContextVisibilityMode({
        cfg,
        channel: "slack",
        accountId: "work",
      }),
    ).toBe("all");
    expect(
      resolveChannelContextVisibilityMode({
        cfg,
        channel: "slack",
        accountId: "missing",
      }),
    ).toBe("allowlist");
    expect(
      resolveChannelContextVisibilityMode({
        cfg: {
          channels: {
            defaults: { contextVisibility: "allowlist_quote" },
          },
        } satisfies OpenClawConfig,
        channel: "signal",
      }),
    ).toBe("allowlist_quote");
  });

  it("defaults to all when unset", () => {
    expect(
      resolveChannelContextVisibilityMode({
        cfg: {},
        channel: "telegram",
      }),
    ).toBe("all");
  });
});
