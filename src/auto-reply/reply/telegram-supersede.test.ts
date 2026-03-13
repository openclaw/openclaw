import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveTelegramSupersedeDebounceMs,
  resolveTelegramSupersedeQueueOverride,
} from "./telegram-supersede.js";

describe("telegram supersede helpers", () => {
  it("returns no override when channel is not telegram", () => {
    const cfg = {} as OpenClawConfig;
    expect(resolveTelegramSupersedeQueueOverride({ cfg, channel: "discord" })).toEqual({});
  });

  it("enables interrupt mode for latest-wins", () => {
    const cfg = {
      channels: {
        telegram: {
          supersede: {
            enabled: true,
            policy: "latest-wins",
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveTelegramSupersedeQueueOverride({ cfg, channel: "telegram" })).toEqual({
      inlineMode: "interrupt",
      inlineOptions: {
        debounceMs: 0,
      },
    });
  });

  it("uses account override and exposes burst debounce", () => {
    const cfg = {
      channels: {
        telegram: {
          supersede: {
            enabled: true,
            policy: "latest-wins",
            graceMs: 10,
          },
          accounts: {
            alpha: {
              supersede: {
                enabled: true,
                policy: "burst-coalesce",
                graceMs: 1200,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveTelegramSupersedeQueueOverride({
        cfg,
        channel: "telegram",
        accountId: "alpha",
      }),
    ).toEqual({
      inlineMode: "interrupt",
      inlineOptions: {
        cap: 1,
        dropPolicy: "old",
        debounceMs: 1200,
      },
    });

    expect(resolveTelegramSupersedeDebounceMs({ cfg, accountId: "alpha" })).toBe(1200);
    expect(resolveTelegramSupersedeDebounceMs({ cfg })).toBe(0);
  });
});
