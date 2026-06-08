import { describe, expect, it } from "vitest";
import { resolveReplyHookTrigger, resolveReplyRunFireReason } from "./run-provenance.js";

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

describe("resolveReplyHookTrigger", () => {
  it("reports same-session continuation wakes as heartbeat triggers without requiring isHeartbeat", () => {
    expect(resolveReplyHookTrigger({ continuationTrigger: "work-wake" })).toBe("heartbeat");
    expect(resolveReplyHookTrigger({ continuationTrigger: "delegate-return" })).toBe("heartbeat");
  });

  it("keeps ordinary turns as user triggers", () => {
    expect(resolveReplyHookTrigger({})).toBe("user");
  });
});
