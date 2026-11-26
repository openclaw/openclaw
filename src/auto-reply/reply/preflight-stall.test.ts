import { afterEach, expect, it, vi } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  createCompactionStall,
  renderPreflightStallText,
  startMemoryFlushStallGuard,
} from "./preflight-stall.js";

afterEach(() => {
  vi.useRealTimers();
});

it("names the stalled compaction model and what to do", () => {
  const stall = createCompactionStall(
    "Compaction timed out",
    { agents: { defaults: { compaction: { model: "ollama/qwen-local", timeoutSeconds: 180 } } } },
    { provider: "openai", model: "gpt-main" },
  );
  if (!stall) {
    throw new Error("timeout reason did not produce a stall");
  }
  expect(createCompactionStall("summary refused", {}, {})).toBeUndefined();
  expect(stall.message).toMatch(/^Preflight compaction required but failed: /u);
  expect(renderPreflightStallText(stall)).toBe(
    "⚠️ Compaction before this reply stalled: ollama/qwen-local sent no output for 180s. " +
      "Check that the model is running and responsive (for a slow local model, raise " +
      "agents.defaults.compaction.timeoutSeconds), then try again.",
  );
  expect(renderPreflightStallText(new Error(stall.message))).toBeUndefined();
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
  expect(renderPreflightStallText(guard.stall)).toContain(
    "Memory maintenance before this reply stalled: ollama/qwen-local sent no output for 5s.",
  );
  guard.stop();
});
