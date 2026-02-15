import { describe, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "./inbound-debounce.js";

describe("createInboundDebouncer flush retry", () => {
  it("retries flush with exponential backoff on failure", async () => {
    vi.useFakeTimers();
    const lockErr = new Error("timeout acquiring session store lock");
    const onFlush = vi
      .fn<(items: string[]) => Promise<void>>()
      .mockRejectedValueOnce(lockErr)
      .mockRejectedValueOnce(lockErr)
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    const debouncer = createInboundDebouncer<string>({
      debounceMs: 10,
      buildKey: (item) => item,
      onFlush,
      onError,
      retryAttempts: 3,
      retryBaseMs: 1,
    });

    void debouncer.enqueue("hello");
    // Advance past debounce + retry delays
    await vi.advanceTimersByTimeAsync(5000);

    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(onFlush).toHaveBeenCalledWith(["hello"]);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("calls onError after exhausting all retry attempts", async () => {
    vi.useFakeTimers();
    const lockErr = new Error("timeout acquiring session store lock");
    const onFlush = vi.fn<(items: string[]) => Promise<void>>().mockRejectedValue(lockErr);
    const onError = vi.fn();

    const debouncer = createInboundDebouncer<string>({
      debounceMs: 10,
      buildKey: (item) => item,
      onFlush,
      onError,
      retryAttempts: 2,
      retryBaseMs: 1,
    });

    void debouncer.enqueue("msg");
    await vi.advanceTimersByTimeAsync(5000);

    // 1 initial + 2 retries = 3 total attempts
    expect(onFlush).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledWith(lockErr, ["msg"]);
    vi.useRealTimers();
  });

  it("does not retry when flush succeeds on first attempt", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn<(items: string[]) => Promise<void>>().mockResolvedValueOnce(undefined);
    const onError = vi.fn();

    const debouncer = createInboundDebouncer<string>({
      debounceMs: 10,
      buildKey: (item) => item,
      onFlush,
      onError,
      retryAttempts: 3,
      retryBaseMs: 1,
    });

    void debouncer.enqueue("ok");
    await vi.advanceTimersByTimeAsync(5000);

    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
