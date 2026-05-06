import { describe, expect, it } from "vitest";
import { resolveReplyRunFireReason } from "./run-provenance.js";

describe("resolveReplyRunFireReason", () => {
  it("classifies continuation work wakes as timer-fired runs", () => {
    expect(
      resolveReplyRunFireReason({
        opts: { isHeartbeat: true, continuationTrigger: "work-wake" },
      }),
    ).toBe("timer");
  });

  it("classifies delegate-return wakes and delegate-draining turns as continuation chains", () => {
    expect(
      resolveReplyRunFireReason({
        opts: { isHeartbeat: true, continuationTrigger: "delegate-return" },
      }),
    ).toBe("continuation-chain");
    expect(resolveReplyRunFireReason({ drainsContinuationDelegateQueue: true })).toBe(
      "continuation-chain",
    );
  });

  it("classifies ordinary inbound turns as external triggers", () => {
    expect(resolveReplyRunFireReason({})).toBe("external-trigger");
  });
});
