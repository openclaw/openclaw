import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler, resolveTypingMode } from "./typing-mode.js";
import { createTypingController } from "./typing.js";

describe("typing controller", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops after run completion and dispatcher idle", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(1_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(4);
  });

  it("keeps typing until both idle and run completion are set", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markDispatchIdle();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);

    typing.markRunComplete();
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).toHaveBeenCalledTimes(3);
  });

  it("does not start typing after run completion", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    typing.markRunComplete();
    await typing.startTypingOnText("late text");
    vi.advanceTimersByTime(2_000);
    expect(onReplyStart).not.toHaveBeenCalled();
  });

  it("does not restart typing after it has stopped", async () => {
    vi.useFakeTimers();
    const onReplyStart = vi.fn(async () => {});
    const typing = createTypingController({
      onReplyStart,
      typingIntervalSeconds: 1,
      typingTtlMs: 30_000,
    });

    await typing.startTypingLoop();
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    typing.markRunComplete();
    typing.markDispatchIdle();

    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);

    // Late callbacks should be ignored and must not restart the interval.
    await typing.startTypingOnText("late tool result");
    vi.advanceTimersByTime(5_000);
    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });
});

describe("resolveTypingMode", () => {
  it("defaults to instant for direct chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("defaults to message for group chats without mentions", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("defaults to instant for mentioned group chats", () => {
    expect(
      resolveTypingMode({
        configured: undefined,
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("instant");
  });

  it("honors configured mode across contexts", () => {
    expect(
      resolveTypingMode({
        configured: "thinking",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: false,
      }),
    ).toBe("thinking");
    expect(
      resolveTypingMode({
        configured: "message",
        isGroupChat: true,
        wasMentioned: true,
        isHeartbeat: false,
      }),
    ).toBe("message");
  });

  it("forces never for heartbeat runs", () => {
    expect(
      resolveTypingMode({
        configured: "instant",
        isGroupChat: false,
        wasMentioned: false,
        isHeartbeat: true,
      }),
    ).toBe("never");
  });
});

describe("createTypingSignaler", () => {
  it("signals immediately for instant mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: false,
    });

    await signaler.signalRunStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("signals on text for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hello");

    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("signals on message start for message mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalMessageStart();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hello");
    expect(typing.startTypingOnText).toHaveBeenCalledWith("hello");
  });

  it("signals on reasoning for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalReasoningDelta();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    await signaler.signalTextDelta("hi");
    expect(typing.startTypingLoop).toHaveBeenCalled();
  });

  it("refreshes ttl on text for thinking mode", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "thinking",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hi");

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("starts typing on tool start before text", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalToolStart();

    expect(typing.startTypingLoop).toHaveBeenCalled();
    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });

  it("refreshes ttl on tool start when active after text", async () => {
    const typing = createMockTypingController({
      isActive: vi.fn(() => true),
    });
    const signaler = createTypingSignaler({
      typing,
      mode: "message",
      isHeartbeat: false,
    });

    await signaler.signalTextDelta("hello");
    typing.startTypingLoop.mockClear();
    typing.startTypingOnText.mockClear();
    typing.refreshTypingTtl.mockClear();
    await signaler.signalToolStart();

    expect(typing.refreshTypingTtl).toHaveBeenCalled();
    expect(typing.startTypingLoop).not.toHaveBeenCalled();
  });

  it("suppresses typing when disabled", async () => {
    const typing = createMockTypingController();
    const signaler = createTypingSignaler({
      typing,
      mode: "instant",
      isHeartbeat: true,
    });

    await signaler.signalRunStart();
    await signaler.signalTextDelta("hi");
    await signaler.signalReasoningDelta();

    expect(typing.startTypingLoop).not.toHaveBeenCalled();
    expect(typing.startTypingOnText).not.toHaveBeenCalled();
  });
});
