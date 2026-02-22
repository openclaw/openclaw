import { describe, expect, it } from "vitest";
import { resolveSlackThreadContext, resolveSlackThreadTargets } from "./threading.js";

describe("resolveSlackThreadTargets", () => {
  it("threads replies when message is already threaded", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(replyThreadTs).toBe("456");
    expect(statusThreadTs).toBe("456");
  });

  it("threads top-level replies when mode is all", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBe("123");
    expect(statusThreadTs).toBe("123");
  });

  it("keeps status threading even when reply threading is off", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(replyThreadTs).toBeUndefined();
    expect(statusThreadTs).toBe("123");
  });

  it("sets messageThreadId for top-level messages when replyToMode is all", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
      },
    });

    expect(context.isThreadReply).toBe(false);
    expect(context.messageThreadId).toBe("123");
    expect(context.replyToId).toBe("123");
  });

  it("prefers thread_ts as messageThreadId for replies", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "456",
      },
    });

    expect(context.isThreadReply).toBe(true);
    expect(context.messageThreadId).toBe("456");
    expect(context.replyToId).toBe("456");
  });

  it("respects replyToMode off when thread_ts is auto-created (same as ts)", () => {
    // Slack's "Agents & AI Apps" feature auto-creates thread_ts equal to ts
    // for top-level channel messages. replyToMode: "off" should keep replies
    // in the main channel, not force them into the auto-created thread.
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123", // auto-created: same as ts
      },
    });

    expect(replyThreadTs).toBeUndefined();
    expect(statusThreadTs).toBe("123");
  });

  it("threads auto-created thread_ts when replyToMode is all", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "all",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123", // auto-created: same as ts
      },
    });

    expect(replyThreadTs).toBe("123");
    expect(statusThreadTs).toBe("123");
  });

  it("uses messageTs for first reply when thread_ts is auto-created and replyToMode is first", () => {
    const { replyThreadTs, statusThreadTs } = resolveSlackThreadTargets({
      replyToMode: "first",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123", // auto-created: same as ts
      },
    });

    // "first" mode should use messageTs (not the auto-created thread_ts)
    // so the first reply starts a proper thread from the message itself.
    expect(replyThreadTs).toBe("123");
    expect(statusThreadTs).toBe("123");
  });

  it("identifies auto-created thread_ts as non-thread-reply", () => {
    const context = resolveSlackThreadContext({
      replyToMode: "off",
      message: {
        type: "message",
        channel: "C1",
        ts: "123",
        thread_ts: "123", // auto-created: same as ts, no parent_user_id
      },
    });

    expect(context.isThreadReply).toBe(false);
    expect(context.messageThreadId).toBeUndefined();
  });
});
