import { describe, expect, it, vi } from "vitest";
import { registerFanOutAgent } from "./fanout-coordinator.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

function makeCtx(): DiscordMessagePreflightContext {
  return {
    isFanOutBotMessage: false,
  } as DiscordMessagePreflightContext;
}

describe("fanout coordinator", () => {
  it("counts processing errors as a completed silent turn without waiting for timeout", async () => {
    vi.useFakeTimers();
    try {
      const channelId = `chan-err-${Date.now()}`;
      const erroredProcess = vi.fn(async () => {
        throw new Error("rate limited");
      });
      const nextProcess = vi.fn(async () => {});

      registerFanOutAgent({
        channelId,
        messageId: "m1",
        accountId: "gilfoyle",
        botUserId: "bot-g",
        mentionedUserIds: [],
        ctx: makeCtx(),
        processMessage: erroredProcess,
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(erroredProcess).toHaveBeenCalledTimes(1);

      registerFanOutAgent({
        channelId,
        messageId: "m2",
        accountId: "gilfoyle",
        botUserId: "bot-g",
        mentionedUserIds: [],
        ctx: makeCtx(),
        processMessage: nextProcess,
      });

      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1500);

      expect(nextProcess).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains a queued pending round even when the previous round had no responses", async () => {
    vi.useFakeTimers();
    try {
      const channelId = `chan-${Date.now()}`;
      const firstProcessed: string[] = [];
      const secondProcessed: string[] = [];
      let releaseFirst: (() => void) | null = null;

      const firstProcess = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            firstProcessed.push("first");
            releaseFirst = resolve;
          }),
      );
      const secondProcess = vi.fn(async () => {
        secondProcessed.push("second");
      });

      registerFanOutAgent({
        channelId,
        messageId: "m1",
        accountId: "gilfoyle",
        botUserId: "bot-g",
        mentionedUserIds: [],
        ctx: makeCtx(),
        processMessage: firstProcess,
      });

      await vi.advanceTimersByTimeAsync(1500);
      expect(firstProcess).toHaveBeenCalledTimes(1);

      // New message arrives while first round is still processing.
      registerFanOutAgent({
        channelId,
        messageId: "m2",
        accountId: "gilfoyle",
        botUserId: "bot-g",
        mentionedUserIds: [],
        ctx: makeCtx(),
        processMessage: secondProcess,
      });

      releaseFirst?.();
      await Promise.resolve();
      // First round times out with no response.
      await vi.advanceTimersByTimeAsync(60_000);
      // Collection window for the queued message.
      await vi.advanceTimersByTimeAsync(1500);

      expect(secondProcess).toHaveBeenCalledTimes(1);
      expect(firstProcessed).toEqual(["first"]);
      expect(secondProcessed).toEqual(["second"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
