import { describe, expect, it, vi } from "vitest";
import type { ReplyOperationPhase } from "./reply-run-registry.js";
import {
  buildReplyRunProgressNoticeText,
  createReplyRunProgressWatchdog,
} from "./reply-run-watchdog.js";

describe("reply run progress watchdog", () => {
  it("emits a deterministic progress notice after the first quiet interval", async () => {
    vi.useFakeTimers();
    try {
      let phase: ReplyOperationPhase = "running";
      const notices: string[] = [];
      createReplyRunProgressWatchdog({
        enabled: true,
        firstNoticeMs: 1_000,
        repeatNoticeMs: 1_000,
        getPhase: () => phase,
        sendNotice: (notice) => {
          notices.push(buildReplyRunProgressNoticeText(notice));
        },
      });

      await vi.advanceTimersByTimeAsync(999);
      expect(notices).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(notices).toEqual([
        "Still working — current phase: running (1m elapsed). I’ll send the final reply when it’s ready.",
      ]);

      phase = "memory_flushing";
      await vi.advanceTimersByTimeAsync(1_000);
      expect(notices.at(-1)).toBe(
        "Still working — current phase: memory flushing (1m elapsed). I’ll send the final reply when it’s ready.",
      );
      expect(notices).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the quiet interval when visible activity is marked", async () => {
    vi.useFakeTimers();
    try {
      const notices: string[] = [];
      const watchdog = createReplyRunProgressWatchdog({
        enabled: true,
        firstNoticeMs: 1_000,
        repeatNoticeMs: 1_000,
        getPhase: () => "running",
        sendNotice: (notice) => {
          notices.push(buildReplyRunProgressNoticeText(notice));
        },
      });

      await vi.advanceTimersByTimeAsync(900);
      watchdog.markVisibleActivity();
      await vi.advanceTimersByTimeAsync(999);
      expect(notices).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(notices).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not emit after the run reaches a terminal phase", async () => {
    vi.useFakeTimers();
    try {
      let phase: ReplyOperationPhase = "running";
      const notices: string[] = [];
      createReplyRunProgressWatchdog({
        enabled: true,
        firstNoticeMs: 1_000,
        repeatNoticeMs: 1_000,
        getPhase: () => phase,
        sendNotice: () => {
          notices.push("notice");
        },
      });

      phase = "completed";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(notices).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
