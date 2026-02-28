import { describe, expect, it, vi } from "vitest";
import { DiscordMessageListener } from "./listeners.js";

function createLogger() {
  return {
    error: vi.fn(),
    warn: vi.fn(),
  };
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

    await expect(listener.handle({} as never, {} as never)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();

    resolveHandler?.();
    await handlerDone;
  });

  it("logs async handler failures", async () => {
    const handler = vi.fn(async () => {
      throw new Error("boom");
    });
    const logger = createLogger();
    const listener = new DiscordMessageListener(handler as never, logger as never);

    await expect(listener.handle({} as never, {} as never)).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("discord handler failed: Error: boom"),
      );
    });
  });
});
