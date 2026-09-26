import { describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { bindChatSendInputRoutingCancellation } from "./chat-send-input-routing.js";

describe("chat input routing cancellation custody", () => {
  it.each([false, true])(
    "cancels pending input from its exact source (already stopped: %s)",
    (stopped) => {
      const source = new AbortController();
      const controller = new AbortController();
      const entry = { abortStopReason: undefined as string | undefined };
      const reason = new Error("source stopped");
      const release = vi.fn();
      if (stopped) {
        source.abort(reason);
      }
      const routing = bindChatSendInputRoutingCancellation(
        { ready: Promise.resolve(), release },
        source.signal,
        { controller, entry },
      );
      source.abort(reason);
      expect(controller.signal.reason).toBe(reason);
      expect(entry.abortStopReason).toBe("rpc");
      // Cancellation is not custody: terminal cleanup still owns the ordering hold.
      expect(release).not.toHaveBeenCalled();
      routing.release();
      routing.release();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("detaches source Stop when delivery takes custody", () => {
    const source = new AbortController();
    const controller = new AbortController();
    const routing = bindChatSendInputRoutingCancellation(
      { ready: Promise.resolve(), release: vi.fn() },
      source.signal,
      { controller },
    );
    routing.release();
    source.abort(new Error("later source Stop"));
    expect(controller.signal.aborted).toBe(false);
  });

  it("preserves restart reasons and the input's first cancellation", () => {
    const source = new AbortController();
    const controller = new AbortController();
    const entry = { abortStopReason: undefined as string | undefined };
    const routing = bindChatSendInputRoutingCancellation(
      { ready: Promise.resolve(), release: vi.fn() },
      source.signal,
      { controller, entry },
    );
    const restart = createAgentRunRestartAbortError();
    source.abort(restart);
    expect(controller.signal.reason).toBe(restart);
    expect(entry.abortStopReason).toBe("restart");
    routing.release();

    const secondSource = new AbortController();
    const alreadyCancelled = new AbortController();
    const originalReason = new Error("input Stop");
    alreadyCancelled.abort(originalReason);
    const originalEntry = { abortStopReason: "rpc" };
    const second = bindChatSendInputRoutingCancellation(
      { ready: Promise.resolve(), release: vi.fn() },
      secondSource.signal,
      { controller: alreadyCancelled, entry: originalEntry },
    );
    secondSource.abort(restart);
    expect(alreadyCancelled.signal.reason).toBe(originalReason);
    expect(originalEntry.abortStopReason).toBe("rpc");
    second.release();
  });
});
