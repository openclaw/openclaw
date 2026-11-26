import { afterEach, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { startMemoryFlushStallGuard } from "./preflight-stall.js";

afterEach(() => {
  vi.useRealTimers();
});

it("aborts a silent flush after the compaction window, measured from its last output", () => {
  vi.useFakeTimers();
  const progress = vi.fn();
  const replyOperation = { watchdog: { progress } } as unknown as ReplyOperation;
  const cfg = { agents: { defaults: { compaction: { timeoutSeconds: 5 } } } };
  expect(startMemoryFlushStallGuard({ cfg }, {}, undefined)).toBeUndefined();
  const guard = startMemoryFlushStallGuard(
    { cfg, replyOperation },
    { provider: "openai", model: "gpt-main" },
    undefined,
  )!;
  guard.setModel("ollama", "qwen-local");
  vi.advanceTimersByTime(4_000);
  guard.progress(new AbortController().signal);
  expect(progress).toHaveBeenCalledWith("semantic", "memory_flush:model_output");
  vi.advanceTimersByTime(4_999);
  expect(guard.signal.aborted).toBe(false);
  vi.advanceTimersByTime(1);
  expect(guard.signal.aborted).toBe(true);
  expect(guard.signal.reason).toBe(guard.stall);
  expect(guard.stall?.message).toBe(
    "memory flush timed out on ollama/qwen-local after 5s without output",
  );
  guard.stop();
});
