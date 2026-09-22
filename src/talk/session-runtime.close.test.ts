import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { RealtimeVoiceBridgeCallbacks } from "./provider-types.js";
import { createRealtimeVoiceBridgeSession } from "./session-runtime.js";
import { makeBridge } from "./session-runtime.test-support.js";

describe("realtime voice bridge finalization", () => {
  it("keeps legacy disposal synchronous when its terminal callback closes again", () => {
    let reentrantClose: void | Promise<void> = undefined;
    const close = vi.fn(() => {
      reentrantClose = session.close();
    });
    const session = createRealtimeVoiceBridgeSession({
      provider: {
        id: "test",
        label: "Test",
        isConfigured: () => true,
        createBridge: () => makeBridge({ close }),
      },
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
    });

    expect(session.close()).toBeUndefined();
    expect(reentrantClose).toBeUndefined();
    expect(session.close()).toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "drains final transcripts while async close settles (failure=%s)",
    async (fails) => {
      const completion = createDeferred();
      let callbacks: RealtimeVoiceBridgeCallbacks | undefined;
      const close = vi.fn(() => {
        void session.close();
        return completion.promise;
      });
      const providerBridge = makeBridge({ close, handleBargeIn: vi.fn() });
      const onTranscript = vi.fn();
      const onToolCall = vi.fn();
      const sendAudio = vi.fn();
      const session = createRealtimeVoiceBridgeSession({
        provider: {
          id: "test",
          label: "Test",
          isConfigured: () => true,
          createBridge: (request) => {
            callbacks = request;
            return providerBridge;
          },
        },
        providerConfig: {},
        audioSink: { sendAudio },
        onTranscript,
        onToolCall,
      });

      callbacks?.onTranscript?.("user", "active fragment", false);
      callbacks?.onTranscript?.("assistant", "active final", true);
      expect(onTranscript.mock.calls).toEqual([
        ["user", "active fragment", false],
        ["assistant", "active final", true],
      ]);
      onTranscript.mockClear();

      const closing = session.close();
      expect(closing).toBeInstanceOf(Promise);
      expect(session.close()).toBe(closing);
      session.sendAudio(Buffer.from("late input"));
      session.acknowledgeMark("late mark");
      session.setMediaTimestamp(42);
      session.handleBargeIn();
      void session.submitToolResult("late call", {});
      callbacks?.onAudio(Buffer.from("late output"));
      callbacks?.onToolCall?.({
        itemId: "late item",
        callId: "late call",
        name: "lookup",
        args: {},
      });
      callbacks?.onTranscript?.("user", "closing user fragment", false);
      callbacks?.onTranscript?.("assistant", "closing assistant fragment", false);
      expect(onTranscript).not.toHaveBeenCalled();
      callbacks?.onTranscript?.("assistant", "final words", true);
      await expect(session.connect()).rejects.toThrow("Realtime voice session is closed");
      expect(onTranscript).toHaveBeenCalledExactlyOnceWith("assistant", "final words", true);
      expect(onToolCall).not.toHaveBeenCalled();
      expect(sendAudio).not.toHaveBeenCalled();
      for (const method of [
        "sendAudio",
        "acknowledgeMark",
        "setMediaTimestamp",
        "handleBargeIn",
        "submitToolResult",
      ] as const) {
        expect(providerBridge[method]).not.toHaveBeenCalled();
      }

      if (fails) {
        const failure = new Error("cleanup failed");
        completion.reject(failure);
        await expect(closing).rejects.toBe(failure);
      } else {
        completion.resolve();
        await closing;
      }
      callbacks?.onTranscript?.("assistant", "stale words", true);
      expect(onTranscript).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    },
  );
});
