// Covers reply-to fanout and delivery policy consumption for explicit,
// implicit, single-use, and disabled reply modes.
import { describe, expect, it } from "vitest";
import { createReplyToDeliveryPolicy, createReplyToFanout } from "./reply-policy.js";

describe("createReplyToFanout", () => {
  it("consumes implicit single-use replies once", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "first",
    });

    expect([next(), next(), next()]).toEqual(["reply-1", undefined, undefined]);
  });

  it("keeps explicit replies reusable even in single-use modes", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "explicit",
      replyToMode: "first",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });

  it("keeps all-mode replies reusable", () => {
    const next = createReplyToFanout({
      replyToId: "reply-1",
      replyToIdSource: "implicit",
      replyToMode: "all",
    });

    expect([next(), next()]).toEqual(["reply-1", "reply-1"]);
  });
});

describe("createReplyToDeliveryPolicy", () => {
  it("consumes payload-carried implicit reply ids in single-use modes", () => {
    const policy = createReplyToDeliveryPolicy({ replyToMode: "first" });
    const payload = { text: "reply", replyToId: "reply-1", replyToIdSource: "implicit" } as const;

    const first = policy.resolveCurrentReplyTo(payload);
    expect(policy.applyReplyToConsumption(first, { consumeImplicitReply: true })).toEqual(first);
    const second = policy.resolveCurrentReplyTo(payload);
    expect(policy.applyReplyToConsumption(second, { consumeImplicitReply: true })).toEqual({
      ...second,
      replyToId: undefined,
    });
  });
});
