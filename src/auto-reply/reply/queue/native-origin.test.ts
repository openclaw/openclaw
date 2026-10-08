import { describe, expect, it } from "vitest";
import { resolveCollectedRun, resolveSyntheticOverflowRun } from "./collected-run.js";
import { createOverflowSummaryRetrySource } from "./delivery-context.js";
import type { FollowupRun } from "./types.js";

const origin = {
  messageId: "91",
  conversation: { channel: "telegram", accountId: "default", conversationId: "-1001:topic:42" },
};

function source(): FollowupRun {
  return {
    prompt: "native user turn",
    run: { inboundTransport: origin },
  } as FollowupRun;
}

describe("queued native message origin", () => {
  it("retains one original user turn but never attributes an aggregate or overflow retry to it", () => {
    const turn = source();
    expect(resolveCollectedRun([turn], turn.run).inboundTransport).toEqual(origin);
    expect(resolveCollectedRun([turn, source()], turn.run).inboundTransport).toBeUndefined();
    expect(createOverflowSummaryRetrySource(turn).run).toBe(turn.run);
    expect(resolveSyntheticOverflowRun([turn], turn.run).inboundTransport).toBeUndefined();
  });
});
