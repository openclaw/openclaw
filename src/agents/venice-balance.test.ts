import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  _veniceBalanceInternals,
  shouldSkipVeniceForLowBalance,
  VENICE_LOW_BALANCE_DEFAULT_USD,
} from "./venice-balance.js";

function makeCfg(override?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    auth: {
      cooldowns: {},
    },
    ...override,
  } as OpenClawConfig;
}

describe("venice balance guard", () => {
  afterEach(() => {
    _veniceBalanceInternals.clearCache();
    delete process.env.VENICE_API_KEY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("extracts USD/DIEM balances from Venice payload", () => {
    const parsed = _veniceBalanceInternals.extractBalances({
      data: {
        balances: {
          USD: 1.8,
          DIEM: "0.15",
        },
      },
    });
    expect(parsed).toEqual({
      usdBalance: 1.8,
      diemBalance: 0.15,
    });
  });

  it("skips Venice when USD balance is below default threshold", async () => {
    process.env.VENICE_API_KEY = "test-venice-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              balances: {
                USD: 0.01,
                DIEM: 0.2,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await shouldSkipVeniceForLowBalance({
      cfg: makeCfg(),
      now: Date.UTC(2026, 2, 3, 11, 0, 0),
    });

    expect(result.skip).toBe(true);
    expect(result.thresholdUsd).toBe(VENICE_LOW_BALANCE_DEFAULT_USD);
    expect(result.snapshot?.usdBalance).toBe(0.01);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses configured threshold and allows Venice when balance is above it", async () => {
    process.env.VENICE_API_KEY = "test-venice-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              balances: {
                USD: 0.2,
                DIEM: 0.12,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const cfg = makeCfg({
      auth: {
        cooldowns: {
          veniceMinUsdBalance: 0.1,
        },
      },
    });
    const result = await shouldSkipVeniceForLowBalance({
      cfg,
      now: Date.UTC(2026, 2, 3, 11, 0, 0),
    });

    expect(result.skip).toBe(false);
    expect(result.thresholdUsd).toBe(0.1);
    expect(result.snapshot?.usdBalance).toBe(0.2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches balance checks for repeated calls", async () => {
    process.env.VENICE_API_KEY = "test-venice-key";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              balances: {
                USD: 1.2,
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const cfg = makeCfg();
    const now = Date.UTC(2026, 2, 3, 11, 0, 0);

    const first = await shouldSkipVeniceForLowBalance({ cfg, now });
    const second = await shouldSkipVeniceForLowBalance({ cfg, now: now + 1_000 });

    expect(first.skip).toBe(false);
    expect(second.skip).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
