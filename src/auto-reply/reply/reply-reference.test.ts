import { describe, expect, it } from "vitest";

import { createReplyReferencePlanner } from "./reply-reference.js";

describe("createReplyReferencePlanner", () => {
  it("disables references when mode is off", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      startId: "parent",
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
  });

  it("uses startId once when mode is first", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "first",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.hasReplied()).toBe(true);
    planner.markSent();
    expect(planner.use()).toBeUndefined();
  });

  it("returns startId for every call when mode is all", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
    });
    expect(planner.use()).toBe("parent");
    expect(planner.use()).toBe("parent");
  });

  it("prefers existing thread id regardless of mode", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "off",
      existingId: "thread-1",
      startId: "parent",
    });
    expect(planner.use()).toBe("thread-1");
    expect(planner.hasReplied()).toBe(true);
  });

  it("honors allowReference=false", () => {
    const planner = createReplyReferencePlanner({
      replyToMode: "all",
      startId: "parent",
      allowReference: false,
    });
    expect(planner.use()).toBeUndefined();
    expect(planner.hasReplied()).toBe(false);
    planner.markSent();
    expect(planner.hasReplied()).toBe(true);
  });
});
