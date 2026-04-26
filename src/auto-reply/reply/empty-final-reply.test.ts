import { describe, expect, it } from "vitest";
import { EMPTY_FINAL_REPLY_TEXT, buildEmptyFinalReplyPayload } from "./empty-final-reply.js";

describe("empty final reply fallback", () => {
  it("builds a deterministic error payload for user runs that produce no visible output", () => {
    expect(
      buildEmptyFinalReplyPayload({
        isHeartbeat: false,
      }),
    ).toEqual({ text: EMPTY_FINAL_REPLY_TEXT, isError: true });
  });

  it("suppresses the fallback when another visible path already handled the run", () => {
    expect(buildEmptyFinalReplyPayload({ isHeartbeat: true })).toBeUndefined();
    expect(
      buildEmptyFinalReplyPayload({ isHeartbeat: false, silentExpected: true }),
    ).toBeUndefined();
    expect(
      buildEmptyFinalReplyPayload({
        isHeartbeat: false,
        hasVisibleBlockReply: true,
      }),
    ).toBeUndefined();
    expect(
      buildEmptyFinalReplyPayload({
        isHeartbeat: false,
        hasMessagingToolSend: true,
      }),
    ).toBeUndefined();
  });
});
