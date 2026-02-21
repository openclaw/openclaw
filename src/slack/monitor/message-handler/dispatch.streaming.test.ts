import { describe, expect, it } from "vitest";
import {
  isSlackStreamingEnabled,
  resolveSlackReplyTeamId,
  resolveSlackStreamingThreadHint,
} from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("is enabled when config is undefined", () => {
    expect(isSlackStreamingEnabled(undefined)).toBe(true);
  });

  it("can be disabled explicitly", () => {
    expect(isSlackStreamingEnabled(false)).toBe(false);
    expect(isSlackStreamingEnabled(true)).toBe(true);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "1000.1",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "1000.2",
      }),
    ).toBe("1000.2");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
      }),
    ).toBe("2000.1");
  });
});

describe("slack stream recipient team id", () => {
  it("uses message team_id when available", () => {
    expect(
      resolveSlackReplyTeamId({
        messageTeamId: "T_TEAM",
        ctxTeamId: "T_CTX",
      }),
    ).toBe("T_TEAM");
  });

  it("falls back to context teamId when message team_id is missing", () => {
    expect(
      resolveSlackReplyTeamId({
        messageTeamId: undefined,
        ctxTeamId: "T_CTX",
      }),
    ).toBe("T_CTX");
  });

  it("returns undefined if no team id is available", () => {
    expect(resolveSlackReplyTeamId({})).toBeUndefined();
  });
});
