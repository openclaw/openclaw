import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readChannelAllowFromStoreMock(...args),
}));

import { clearSlackAllowFromCacheForTest, resolveSlackEffectiveAllowFrom } from "./auth.js";

function makeSlackCtx(allowFrom: string[]): SlackMonitorContext {
  return {
    allowFrom,
    accountId: "main",
    dmPolicy: "pairing",
  } as unknown as SlackMonitorContext;
}

describe("resolveSlackEffectiveAllowFrom", () => {
  const prevTtl = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;

  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
    clearSlackAllowFromCacheForTest();
    if (prevTtl === undefined) {
      delete process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS;
    } else {
      process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = prevTtl;
    }
  });

  it("falls back to channel config allowFrom when pairing store throws", async () => {
    readChannelAllowFromStoreMock.mockRejectedValueOnce(new Error("boom"));

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("treats malformed non-array pairing-store responses as empty", async () => {
    readChannelAllowFromStoreMock.mockReturnValueOnce(undefined);

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective.allowFrom).toEqual(["u1"]);
    expect(effective.allowFromLower).toEqual(["u1"]);
  });

  it("memoizes pairing-store allowFrom reads within TTL", async () => {
    readChannelAllowFromStoreMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    const first = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    const second = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(first.allowFrom).toEqual(["u1", "u2"]);
    expect(second.allowFrom).toEqual(["u1", "u2"]);
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes pairing-store allowFrom when cache TTL is zero", async () => {
    process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS = "0";
    readChannelAllowFromStoreMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });
    await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(2);
  });
});
