import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn());

vi.mock("../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: (...args: unknown[]) => readChannelAllowFromStoreMock(...args),
}));

import { resolveSlackEffectiveAllowFrom } from "./auth.js";

function makeSlackCtx(allowFrom: string[]): SlackMonitorContext {
  return {
    allowFrom,
  } as unknown as SlackMonitorContext;
}

describe("resolveSlackEffectiveAllowFrom", () => {
  beforeEach(() => {
    readChannelAllowFromStoreMock.mockReset();
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
});
