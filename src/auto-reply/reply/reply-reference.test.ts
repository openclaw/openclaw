import { describe, expect, it } from "vitest";
import { createReplyReferencePlanner } from "./reply-reference.js";

describe("createReplyReferencePlanner", () => {
  it("returns existingId when replyToMode is not off", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      existingId: "thread-123",
    });
    expect(planner.use()).toBe("thread-123");
    expect(planner.hasReplied()).toBe(true);
  });

  it("returns existingId when replyToMode is off (stays in existing thread)", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      existingId: "thread-123",
    });
    // existingId means we're already inside a thread — always stay in it
    expect(planner.use()).toBe("thread-123");
    expect(planner.hasReplied()).toBe(true);
  });

  it("returns undefined when replyToMode is off with startId", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "msg-456",
    });
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId on first call when replyToMode is first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "msg-456",
    });
    expect(planner.use()).toBe("msg-456");
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId on every call when replyToMode is all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "msg-456",
    });
    expect(planner.use()).toBe("msg-456");
    expect(planner.use()).toBe("msg-456");
  });

  it("returns undefined when allowReference is false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      existingId: "thread-123",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
  });

  it("markSent prevents startId on second call for first mode", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "msg-456",
    });
    planner.markSent();
    expect(planner.use()).toBeUndefined();
  });
});
