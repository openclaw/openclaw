import { describe, expect, it, vi } from "vitest";
import { createTypingCallbacks } from "./typing.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createTypingCallbacks", () => {
  it("invokes start on reply start", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(start).toHaveBeenCalledTimes(1);
    expect(onStartError).not.toHaveBeenCalled();
  });

  it("reports start errors", async () => {
    const start = vi.fn().mockRejectedValue(new Error("fail"));
    const onStartError = vi.fn();
    const callbacks = createTypingCallbacks({ start, onStartError });

    await callbacks.onReplyStart();

    expect(onStartError).toHaveBeenCalledTimes(1);
  });

  it("invokes stop on idle and reports stop errors", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockRejectedValue(new Error("stop"));
    const onStartError = vi.fn();
    const onStopError = vi.fn();
    const callbacks = createTypingCallbacks({ start, stop, onStartError, onStopError });

    callbacks.onIdle?.();
    await flush();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopError).toHaveBeenCalledTimes(1);
  });
});
