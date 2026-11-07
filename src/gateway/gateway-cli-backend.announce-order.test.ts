import { describe, expect, it } from "vitest";
import { findCliAnnounceReplyIndexes } from "./gateway-cli-backend.announce-order.test-support.js";

describe("CLI announcement canonical reply ordering", () => {
  it("finds a later completion even when the parent invocation mentioned the child", () => {
    expect(findCliAnnounceReplyIndexes(["PARENT CHILD", "CHILD"], "PARENT", "CHILD")).toEqual({
      parentReplyIndex: 0,
      completionReplyIndex: 1,
    });
  });

  it("does not accept a child mention in the parent row as completion", () => {
    expect(findCliAnnounceReplyIndexes(["PARENT CHILD"], "PARENT", "CHILD")).toEqual({
      parentReplyIndex: 0,
      completionReplyIndex: -1,
    });
  });

  it("does not accept only a completion before the parent", () => {
    expect(findCliAnnounceReplyIndexes(["CHILD", "PARENT"], "PARENT", "CHILD")).toEqual({
      parentReplyIndex: 1,
      completionReplyIndex: -1,
    });
  });

  it("retains ordinary parent-before-completion ordering", () => {
    expect(findCliAnnounceReplyIndexes(["other", "PARENT", "CHILD"], "PARENT", "CHILD")).toEqual({
      parentReplyIndex: 1,
      completionReplyIndex: 2,
    });
  });

  it("does not fabricate a missing parent", () => {
    expect(findCliAnnounceReplyIndexes(["CHILD"], "PARENT", "CHILD").parentReplyIndex).toBe(-1);
  });
});
