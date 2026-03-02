import { describe, expect, it, vi } from "vitest";
import { DiscordMessageListener } from "./listeners.js";

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function fakeEvent(channelId: string) {
  return { channel_id: channelId } as never;
}

describe("DiscordMessageListener", () => {
  it("returns immediately without awaiting handler completion", async () => {
    let resolveHandler: (() => void) | undefined;
    const handlerDone = new Promise<void>((resolve) => {
      resolveHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerDone;
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    resolveHandler?.();
    await handlerDone;
  });

  it("serializes queued handler runs for the same channel", async () => {
    let firstResolve: (() => void) | undefined;
    let secondResolve: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      firstResolve = resolve;
    });
    const secondDone = new Promise<void>((resolve) => {
      secondResolve = resolve;
    });
    let runCount = 0;
    const handler = vi.fn(async () => {
      runCount += 1;
      if (runCount === 1) {
        await firstDone;
        return;
      }
      await secondDone;
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();

    expect(handler).toHaveBeenCalledTimes(1);
    firstResolve?.();
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });

    secondResolve?.();
    await secondDone;
  });

  it("runs handlers for different channels in parallel", async () => {
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const doneA = new Promise<void>((r) => {
      resolveA = r;
    });
    const doneB = new Promise<void>((r) => {
      resolveB = r;
    });
    const order: string[] = [];
    const handler = vi.fn(async (data: { channel_id: string }) => {
      order.push(`start:${data.channel_id}`);
      if (data.channel_id === "ch-a") {
        await doneA;
      } else {
        await doneB;
      }
      order.push(`end:${data.channel_id}`);
    });
    const listener = new DiscordMessageListener(handler as never, createLogger() as never);

    await listener.handle(fakeEvent("ch-a"), {} as never);
    await listener.handle(fakeEvent("ch-b"), {} as never);

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(2);
    });
    expect(order).toContain("start:ch-a");
    expect(order).toContain("start:ch-b");

    resolveB?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-b");
    });
    expect(order).not.toContain("end:ch-a");

    resolveA?.();
    await vi.waitFor(() => {
      expect(order).toContain("end:ch-a");
    });
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle(fakeEvent("ch-1"), {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("discord handler failed: Error: boom"),
      );
    });
  });
});
