import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import type { MsgContext } from "../templating.js";
import {
  claimInboundDedupe as claimInbound,
  resetInboundDedupe as resetInbound,
} from "./inbound-dedupe.js";

const context: MsgContext = {
  OriginatingChannel: "discord",
  OriginatingTo: "channel:c1",
  SessionKey: "agent:main:discord:channel:c1",
  MessageSid: "msg-1",
};

function claim(ctx: MsgContext, claimFn = claimInbound) {
  const result = claimFn(ctx);
  expect(result.status).toBe("claimed");
  if (result.status !== "claimed") {
    throw new Error(`expected claimed inbound dedupe result, got ${result.status}`);
  }
  return result;
}

const fresh = (scope: string) =>
  importFreshModule<typeof import("./inbound-dedupe.js")>(
    import.meta.url,
    `./inbound-dedupe.js?scope=${scope}`,
  );

afterEach(() => {
  resetInbound();
  vi.useRealTimers();
});

it("deduplicates inbound messages with equivalent numeric and string thread ids", () => {
  claim({ ...context, MessageThreadId: 77 }).commit();
  expect(claimInbound({ ...context, MessageThreadId: "77" }).status).toBe("duplicate");
});

it.each([
  { CommandSource: "native", CommandBody: "/stop", CommandAuthorized: true },
  { CommandSource: "text", CommandBody: "/steer keep working", CommandAuthorized: true },
] as const)("admits each explicit target of one $CommandSource command once", (command) => {
  const firstTarget = {
    ...context,
    ...command,
    MessageThreadId: "thread-1",
    CommandTargetSessionKey: "agent:main:discord:channel:c1",
  };
  claim(firstTarget).commit();

  const secondClaim = claimInbound({
    ...firstTarget,
    CommandTargetSessionKey: "agent:main:discord:channel:c1:thread:thread-1",
  });
  expect(secondClaim.status).toBe("claimed");
  expect(claimInbound(firstTarget)).toEqual({ status: "duplicate" });
});

it.each(["release", "commit"] as const)(
  "shares claim/%s across module instances",
  async (action) => {
    const inboundA = await fresh("a");
    const inboundB = await fresh("b");
    const firstClaim = claim(context, inboundA.claimInboundDedupe);
    if (action === "release") {
      expect(inboundB.claimInboundDedupe(context)).toEqual({ status: "inflight" });
    }
    firstClaim[action]();
    const next = inboundB.claimInboundDedupe(context);
    if (action === "release") {
      expect(next.status).toBe("claimed");
    } else {
      expect(next).toEqual({ status: "duplicate" });
    }
  },
);

it("cannot recommit a released claim or free its replacement", () => {
  const abandoned = claim(context);
  abandoned.release();
  const replacement = claim(context);
  abandoned.commit();
  abandoned.release();
  expect(claimInbound(context).status).toBe("inflight");
  replacement.commit();
  abandoned.release();
  expect(claimInbound(context).status).toBe("duplicate");
  replacement.release();
  expect(claimInbound(context).status).toBe("claimed");
});

it("does not release a newer commit after the original entry expires", () => {
  vi.useFakeTimers();
  const expired = claim(context);
  expired.commit();
  vi.advanceTimersByTime(20 * 60_000);
  const replacement = claim(context);
  replacement.commit();
  expired.release();
  expect(claimInbound(context).status).toBe("duplicate");
  replacement.release();
  expect(claimInbound(context).status).toBe("claimed");
});
