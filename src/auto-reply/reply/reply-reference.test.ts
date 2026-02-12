import { describe, expect, it } from "vitest";
import { createReplyReferencePlanner } from "./reply-reference.js";

describe("createReplyReferencePlanner", () => {
  it("returns existingId when replyToMode is not off", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      existingId: "thread-123",
      startId: "msg-1",
    });
    expect(planner.use()).toBe("thread-123");
    expect(planner.hasReplied()).toBe(true);
  });

  it("returns undefined when replyToMode is off even with existingId", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      existingId: "thread-123",
      startId: "msg-1",
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
  });

  it("returns undefined when replyToMode is off without existingId", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "msg-1",
    });
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId on first call for replyToMode first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "msg-1",
    });
    expect(planner.use()).toBe("msg-1");
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId on every call for replyToMode all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "msg-1",
    });
    expect(planner.use()).toBe("msg-1");
    expect(planner.use()).toBe("msg-1");
  });

  it("returns undefined when allowReference is false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      existingId: "thread-123",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
  });

  it("markSent updates hasReplied", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "msg-1",
    });
    expect(planner.hasReplied()).toBe(false);
    planner.markSent();
    expect(planner.hasReplied()).toBe(true);
    expect(planner.use()).toBeUndefined();
  });
});
