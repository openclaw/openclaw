import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import type { MeetingRealtimeToolCallParams } from "./realtime-engine-types.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";

type PendingWrite = {
  resolve: () => void;
};

async function createEngineFixture(options?: {
  handleToolCall?: (params: MeetingRealtimeToolCallParams) => Promise<void>;
}) {
  let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
  let onHumanBargeIn: ((audio: Buffer) => boolean) | undefined;
  const handleBargeIn = vi.fn();
  const submitToolResult = vi.fn();
  const closeBridge = vi.fn<RealtimeVoiceBridge["close"]>();
  const bridge: RealtimeVoiceBridge = {
    acknowledgeMark: vi.fn(),
    close: closeBridge,
    connect: vi.fn(async () => {}),
    handleBargeIn,
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult,
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createBridge: (request) => {
      callbacks = request;
      return bridge;
    },
  };
  const pendingWrites: PendingWrite[] = [];
  const writeStarts = new Map<number, ReturnType<typeof createDeferredCore<void>>>();
  const writeStart = (count: number) => {
    let receipt = writeStarts.get(count);
    if (!receipt) {
      receipt = createDeferredCore();
      writeStarts.set(count, receipt);
    }
    return receipt;
  };
  const writeOutput = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pendingWrites.push({ resolve });
        writeStart(pendingWrites.length).resolve();
      }),
  );
  const clearOutput = vi.fn(async () => {});
  const beginOutput = vi.fn();
  const stopTransport = vi.fn<MeetingRealtimeAudioTransport["stop"]>(async () => {});
  const disposeTransport = vi.fn<MeetingRealtimeAudioTransport["dispose"]>(async () => {});
  const transport: MeetingRealtimeAudioTransport = {
    beginOutput,
    clearOutput,
    dispose: disposeTransport,
    onFatal: vi.fn(),
    startBargeInMonitor: (handler) => {
      onHumanBargeIn = handler;
    },
    startInput: vi.fn(),
    stop: stopTransport,
    writeOutput,
  };
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const synthesize = vi.fn(async () => ({
    success: true,
    audioBuffer: Buffer.alloc(960, 1),
    sampleRate: 24_000,
    outputFormat: "pcm16",
  }));
  const handle = await startMeetingRealtimeEngine({
    config: {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "bidi",
        provider: "test",
        providers: { test: {} },
      },
    },
    consultAgent: vi.fn(async () => ({ text: "unused" })),
    fullConfig: {} as never,
    handleToolCall: options?.handleToolCall ?? vi.fn(async () => {}),
    logger,
    meetingSessionId: "meeting-1",
    platform: {
      displayName: "Test Meeting",
      logScope: "[meeting-test]",
      sessionIdPrefix: "meeting-test",
    },
    providers: [provider],
    runtime: { tts: { textToSpeechTelephony: synthesize } } as never,
    tools: [],
    transport,
  });
  if (!callbacks) {
    throw new Error("Expected realtime voice bridge callbacks");
  }
  const bridgeCallbacks = callbacks;
  return {
    closeBridge,
    disposeTransport,
    logger,
    stopTransport,
    beginOutput,
    callbacks: bridgeCallbacks,
    clearOutput,
    handle,
    synthesize,
    handleBargeIn,
    submitToolResult,
    async waitForWriteStart(count: number) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          writeStart(count).promise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`Output write ${count} did not start within 1000 ms`)),
              1_000,
            );
          }),
        ]);
        // Give detached work a turn before checking counts/order, without completing the write.
        await setImmediate();
      } finally {
        clearTimeout(timeout);
      }
    },
    releaseWrite(index: number) {
      const pending = pendingWrites[index];
      if (!pending) {
        throw new Error(`Expected pending output write ${index}`);
      }
      pending.resolve();
    },
    announceOutputResponse(responseId: string) {
      bridgeCallbacks.onEvent?.({
        direction: "server",
        responseId,
        type: "response.created",
      });
    },
    sendOutputAudio(audio: Buffer, responseId?: string) {
      bridgeCallbacks.onEvent?.({
        direction: "server",
        ...(responseId ? { responseId } : {}),
        type: "response.audio.delta",
      });
      bridgeCallbacks.onAudio(audio);
    },
    triggerHumanBargeIn(audio = Buffer.from([1])) {
      if (!onHumanBargeIn) {
        throw new Error("Expected human barge-in monitor");
      }
      return onHumanBargeIn(audio);
    },
    writeOutput,
  };
}

describe("meeting realtime engine output ownership", () => {
  it.each([
    ["audio", "before admission"],
    ["audio", "after admission"],
    ["creation", "before admission"],
    ["creation", "after admission"],
  ] as const)(
    "preserves exact playback across a retired provider clear (%s, %s)",
    async (providerStart, clearTiming) => {
      const fixture = await createEngineFixture();
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      let speaking: Promise<void> | undefined;
      try {
        // Google emits unkeyed audio, then acknowledges client cancellation with
        // onClearAudio followed by onResponseDone, possibly in a later message.
        const previousWrites = providerStart === "audio" ? 1 : 0;
        if (providerStart === "audio") {
          fixture.callbacks.onAudio(Buffer.alloc(960, 2));
          await fixture.waitForWriteStart(1);
          fixture.releaseWrite(0);
          await setImmediate();
        } else {
          fixture.callbacks.onEvent?.({ direction: "server", type: "response.created" });
        }
        speaking = Promise.resolve(
          fixture.handle.speak(
            "A literal answer.",
            () => {},
            async () => {},
          ),
        );
        await fixture.waitForWriteStart(previousWrites + 1);
        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
        if (clearTiming === "after admission") {
          fixture.releaseWrite(previousWrites);
          await speaking;
        }

        fixture.callbacks.onClearAudio("barge-in");
        await setImmediate();
        // The clock has not advanced: completed native writes are still queued
        // for playback, even though speak() has released its reservation.
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
        fixture.callbacks.onResponseDone?.({ status: "cancelled" });
        if (clearTiming === "before admission") {
          fixture.releaseWrite(previousWrites);
          await speaking;
        }

        // A provider terminal observed during local speech must still retire
        // the clear fence, without closing the local Talk/audio lifecycle.
        const fresh = Buffer.alloc(960, 3);
        fixture.callbacks.onAudio(fresh);
        await setImmediate();
        expect(fixture.writeOutput).toHaveBeenCalledTimes(previousWrites + 2);
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
        fixture.releaseWrite(previousWrites + 1);
        await setImmediate();
        fixture.callbacks.onClearAudio("barge-in");
        await setImmediate();
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      } finally {
        await fixture.handle.stop();
        for (let index = 0; index < fixture.writeOutput.mock.calls.length; index += 1) {
          fixture.releaseWrite(index);
        }
        await speaking?.catch(() => {});
        now.mockRestore();
      }
    },
  );

  it("preserves an admitted exact utterance while the next reply waits for playback", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_000);
    const fixture = await createEngineFixture();
    const speech: Promise<void>[] = [];
    try {
      speech.push(
        Promise.resolve(
          fixture.handle.speak(
            "First answer",
            () => {},
            async () => {},
          ),
        ),
      );
      await fixture.waitForWriteStart(1);
      fixture.releaseWrite(0);
      await speech[0];
      expect(fixture.clearOutput).toHaveBeenCalledOnce();

      speech.push(
        Promise.resolve(
          fixture.handle.speak(
            "Second answer",
            () => {},
            async () => {},
          ),
        ),
      );
      await setImmediate();
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(19);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      await fixture.waitForWriteStart(2);
      fixture.releaseWrite(1);
      await speech[1];
      expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      expect(fixture.handle.getHealth().recentRealtimeTranscript.map(({ text }) => text)).toEqual([
        "First answer",
        "Second answer",
      ]);
    } finally {
      await fixture.handle.stop();
      for (let index = 0; index < fixture.writeOutput.mock.calls.length; index += 1) {
        fixture.releaseWrite(index);
      }
      await Promise.allSettled(speech);
      vi.useRealTimers();
    }
  });

  it.each(["source edit", "human interruption", "stop"] as const)(
    "rejects the next exact reply after %s while waiting for previous playback",
    async (invalidation) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(1_000);
      const fixture = await createEngineFixture();
      let current = true;
      let second: Promise<void> | undefined;
      try {
        const first = Promise.resolve(
          fixture.handle.speak(
            "First answer",
            () => {},
            async () => {},
          ),
        );
        await fixture.waitForWriteStart(1);
        fixture.releaseWrite(0);
        await first;
        second = Promise.resolve(
          fixture.handle.speak(
            "Second answer",
            () => {
              if (!current) {
                throw new Error("Source changed while waiting");
              }
            },
            async () => {},
          ),
        );
        const rejected = expect(second).rejects.toThrow(
          invalidation === "source edit"
            ? "Source changed while waiting"
            : "Exact meeting speech was interrupted",
        );
        if (invalidation === "source edit") {
          current = false;
          await vi.advanceTimersByTimeAsync(20);
        } else if (invalidation === "human interruption") {
          expect(fixture.triggerHumanBargeIn()).toBe(true);
        } else {
          await fixture.handle.stop();
        }
        await rejected;
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        await fixture.handle.stop();
        for (let index = 0; index < fixture.writeOutput.mock.calls.length; index += 1) {
          fixture.releaseWrite(index);
        }
        await second?.catch(() => {});
        vi.useRealTimers();
      }
    },
  );

  it.each(["typed", "legacy"] as const)(
    "fences retired anonymous transcripts after exact admission until a %s terminal",
    async (terminal) => {
      const fixture = await createEngineFixture();
      let speaking: Promise<void> | undefined;
      try {
        fixture.callbacks.onEvent?.({ direction: "server", type: "response.created" });
        speaking = Promise.resolve(
          fixture.handle.speak(
            "A literal answer.",
            () => {},
            async () => {},
          ),
        );
        await fixture.waitForWriteStart(1);
        fixture.releaseWrite(0);
        await speaking;
        const transcriptBefore = fixture.handle.getHealth().recentRealtimeTranscript;
        fixture.callbacks.onTranscript?.("assistant", "Retired anonymous text", false);
        fixture.callbacks.onTranscript?.("assistant", "Retired anonymous text", true);
        expect(fixture.handle.getHealth().recentRealtimeTranscript).toEqual(transcriptBefore);
        expect(fixture.logger.info).not.toHaveBeenCalledWith(
          expect.stringContaining("Retired anonymous text"),
        );

        fixture.callbacks.onTranscript?.("user", "Still listening", true);
        expect(fixture.handle.getHealth().lastRealtimeTranscriptText).toBe("Still listening");
        fixture.callbacks.onTranscript?.("assistant", "Fresh keyed text", true, undefined, "fresh");
        expect(fixture.handle.getHealth().lastRealtimeTranscriptText).toBe("Fresh keyed text");
        if (terminal === "typed") {
          fixture.callbacks.onResponseDone?.({ status: "cancelled" });
        } else {
          fixture.callbacks.onEvent?.({ direction: "server", type: "response.cancelled" });
        }
        fixture.callbacks.onTranscript?.("assistant", "Fresh anonymous text", true);
        expect(fixture.handle.getHealth().lastRealtimeTranscriptText).toBe("Fresh anonymous text");
      } finally {
        await fixture.handle.stop();
        for (let index = 0; index < fixture.writeOutput.mock.calls.length; index += 1) {
          fixture.releaseWrite(index);
        }
        await speaking?.catch(() => {});
      }
    },
  );

  it("allows human interruption of admitted exact speech while a retired clear is fenced", async () => {
    const fixture = await createEngineFixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let speaking: Promise<void> | undefined;
    try {
      fixture.announceOutputResponse("old-provider-response");
      speaking = Promise.resolve(
        fixture.handle.speak(
          "A literal answer.",
          () => {},
          async () => {},
        ),
      );
      await fixture.waitForWriteStart(1);
      fixture.releaseWrite(0);
      await speaking;
      fixture.callbacks.onClearAudio("barge-in");
      await setImmediate();
      expect(fixture.clearOutput).toHaveBeenCalledOnce();

      expect(fixture.triggerHumanBargeIn()).toBe(true);
      await setImmediate();
      expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      const fresh = Buffer.alloc(960, 3);
      fixture.sendOutputAudio(fresh, "fresh-provider-response");
      await setImmediate();
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
      for (let index = 0; index < fixture.writeOutput.mock.calls.length; index += 1) {
        fixture.releaseWrite(index);
      }
      await speaking?.catch(() => {});
      now.mockRestore();
    }
  });

  it("keeps exact speech open when the retired provider turn completes late", async () => {
    const fixture = await createEngineFixture();
    fixture.announceOutputResponse("old-provider-response");
    const speaking = Promise.resolve(
      fixture.handle.speak(
        "A literal answer.",
        () => {},
        async () => {},
      ),
    );
    try {
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      const started = fixture.handle
        .getHealth()
        .recentTalkEvents.findLast((event) => event.type === "output.audio.started");
      expect(started?.turnId).toBeDefined();
      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "error",
        detail: "Cancellation failed: no active response found",
      });
      fixture.callbacks.onTranscript?.("assistant", "A stale provider answer.", true);
      fixture.callbacks.onResponseDone?.({
        responseId: "old-provider-response",
        status: "completed",
      });
      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: "old-provider-response",
        type: "response.done",
      });
      const pendingEvents = fixture.handle.getHealth().recentTalkEvents;
      expect(pendingEvents).not.toContainEqual(
        expect.objectContaining({ type: "turn.ended", turnId: started?.turnId }),
      );
      expect(pendingEvents).not.toContainEqual(
        expect.objectContaining({ type: "output.audio.done", turnId: started?.turnId }),
      );
      expect(
        pendingEvents.filter(
          (event) => event.type === "output.text.done" && event.turnId === started?.turnId,
        ),
      ).toHaveLength(1);
      fixture.releaseWrite(0);
      await speaking;
      expect(fixture.handle.getHealth().recentTalkEvents).toContainEqual(
        expect.objectContaining({ type: "turn.ended", turnId: started?.turnId }),
      );
    } finally {
      if (fixture.writeOutput.mock.calls.length) {
        fixture.releaseWrite(0);
      }
      await fixture.handle.stop();
      await speaking.catch(() => {});
    }
  });

  it.each(["resolve", "reject"] as const)(
    "drains provider transcripts before %s cleanup releases transport",
    async (outcome) => {
      const fixture = await createEngineFixture();
      const providerClosed = createDeferredCore();
      fixture.closeBridge.mockReturnValue(providerClosed.promise);
      let settled = false;
      const closing = fixture.handle.stop().then(() => {
        settled = true;
      });
      const concurrentClose = fixture.handle.stop();
      try {
        await vi.waitFor(() => expect(fixture.closeBridge).toHaveBeenCalledOnce());
        expect(settled).toBe(false);
        expect(fixture.handle.getHealth().bridgeClosed).toBe(false);
        expect(fixture.stopTransport).not.toHaveBeenCalled();
        expect(fixture.disposeTransport).not.toHaveBeenCalled();
        fixture.callbacks.onTranscript?.("assistant", "Final meeting answer", true);
        expect(fixture.handle.getHealth().recentTalkEvents).toContainEqual(
          expect.objectContaining({
            type: "output.text.done",
            final: true,
          }),
        );
        expect(fixture.logger.info).toHaveBeenCalledWith(
          "[meeting-test] realtime assistant: chars=20",
        );
        if (outcome === "reject") {
          providerClosed.reject(new Error("provider cleanup failed"));
        } else {
          providerClosed.resolve();
        }
        await Promise.all([closing, concurrentClose]);
        expect(settled).toBe(true);
        expect(fixture.stopTransport).toHaveBeenCalledOnce();
        expect(fixture.disposeTransport).toHaveBeenCalledOnce();
        await fixture.handle.stop();
        expect(fixture.closeBridge).toHaveBeenCalledOnce();
      } finally {
        providerClosed.resolve();
        await closing;
      }
    },
  );

  it.each([
    [
      { status: "failed" as const, responseId: "response-1", message: "provider failed" },
      "turn.ended",
    ],
    [
      {
        status: "incomplete" as const,
        responseId: "response-1",
        reason: "max_output_tokens",
        message: "provider response incomplete",
      },
      "turn.ended",
    ],
    [
      { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
      "turn.cancelled",
    ],
  ])("finishes each response once and accepts a later response", async (outcome, terminalType) => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onTranscript?.("user", "first turn", true);
      fixture.announceOutputResponse("response-1");
      fixture.sendOutputAudio(Buffer.from([1]), "response-1");
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      fixture.callbacks.onResponseDone?.(outcome);
      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: outcome.responseId,
        type: "response.done",
      });

      const firstEvents = fixture.handle.getHealth().recentTalkEvents;
      expect(firstEvents.filter((event) => event.type === terminalType)).toHaveLength(1);
      expect(firstEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(1);
      expect(firstEvents.filter((event) => event.type === "session.error")).toHaveLength(
        outcome.status === "failed" || outcome.status === "incomplete" ? 1 : 0,
      );
      expect(fixture.handle.getHealth().bridgeClosed).toBe(false);

      fixture.releaseWrite(0);
      fixture.callbacks.onTranscript?.("user", "later turn", true);
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(Buffer.from([2]), "response-2");
      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      fixture.callbacks.onResponseDone?.({ status: "completed", responseId: "response-2" });
      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: "response-2",
        type: "response.done",
      });

      const finalEvents = fixture.handle.getHealth().recentTalkEvents;
      expect(
        finalEvents.filter(
          (event) => event.type === "turn.ended" || event.type === "turn.cancelled",
        ),
      ).toHaveLength(2);
      expect(finalEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(2);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("rearms continuity reset when the provider creates a fresh session before ready", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "session.created",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      });
    } finally {
      await fixture.handle.stop();
    }
  });

  it("resets provider continuity without replaying old output or tool work", async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const fixture = await createEngineFixture({
      handleToolCall: async ({ session, event, onTalkEvent }) => {
        await toolGate;
        await session.submitToolResult(event.callId, { text: "stale result" });
        onTalkEvent({
          type: "tool.result",
          callId: event.callId,
          payload: { name: event.name },
          final: true,
        });
      },
    });
    try {
      const active = Buffer.from([1]);
      const stale = Buffer.from([2]);
      const fresh = Buffer.from([3]);
      fixture.callbacks.onReady?.();
      fixture.callbacks.onTranscript?.("user", "old turn", true);
      fixture.sendOutputAudio(active, "response-1");
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      fixture.sendOutputAudio(stale, "response-1");
      fixture.callbacks.onToolCall?.({
        itemId: "item-old",
        callId: "call-old",
        name: "openclaw_agent_consult",
        args: { question: "old work" },
      });

      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });

      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });
      expect(fixture.handleBargeIn).not.toHaveBeenCalled();
      expect(
        fixture.handle
          .getHealth()
          .recentTalkEvents.filter((event) => event.type === "turn.cancelled"),
      ).toHaveLength(1);

      releaseTool?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(fixture.submitToolResult).not.toHaveBeenCalled();
      expect(
        fixture.handle.getHealth().recentTalkEvents.some((event) => event.type === "tool.result"),
      ).toBe(false);

      fixture.releaseWrite(0);
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);

      fixture.callbacks.onReady?.();
      fixture.sendOutputAudio(fresh, "response-1");
      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("serializes transport writes and coalesces queued 20 ms frames", async () => {
    const fixture = await createEngineFixture();
    try {
      const first = Buffer.alloc(960, 1);
      const queued = Array.from({ length: 30 }, (_, index) => Buffer.alloc(960, index + 2));

      fixture.callbacks.onAudio(first);
      for (const frame of queued) {
        fixture.callbacks.onAudio(frame);
      }
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

      fixture.releaseWrite(0);
      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(Buffer.concat(queued.slice(0, 25)));

      fixture.releaseWrite(1);
      await fixture.waitForWriteStart(3);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(3);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(Buffer.concat(queued.slice(25)));
      fixture.releaseWrite(2);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("accepts ordered provider output after a clear without a response owner", async () => {
    const fixture = await createEngineFixture();
    try {
      const stale = Buffer.from([1, 2, 3]);
      const fresh = Buffer.from([4, 5, 6]);

      fixture.callbacks.onAudio(stale);
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(fresh);

      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      expect(fixture.beginOutput).toHaveBeenCalledOnce();
      expect(fixture.beginOutput).toHaveBeenCalledAfter(fixture.clearOutput);
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("invalidates queued output when human barge-in clears playback", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.from([1]);
      const stale = Buffer.from([2]);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.announceOutputResponse("response-1");
      fixture.sendOutputAudio(active);
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      fixture.sendOutputAudio(stale);

      expect(fixture.triggerHumanBargeIn()).toBe(true);
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });
      fixture.sendOutputAudio(late);
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(fresh);
      fixture.releaseWrite(0);

      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("rejects a cleared response whose first audio arrives after barge-in", async () => {
    const fixture = await createEngineFixture();
    try {
      const stale = Buffer.from([1]);
      const fresh = Buffer.from([2]);

      fixture.announceOutputResponse("response-1");
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(stale);
      fixture.announceOutputResponse("response-2");
      fixture.callbacks.onAudio(fresh);

      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });

  it.each(["response.done", "response.cancelled"])(
    "bounds queued bytes and rejects stale output through %s",
    async (terminalType) => {
      const fixture = await createEngineFixture();
      try {
        const first = Buffer.alloc(48_000, 1);
        const queued = Buffer.alloc(48_000, 2);
        const overflow = Buffer.from([3]);
        const late = Buffer.from([4]);
        const fresh = Buffer.from([5]);

        fixture.sendOutputAudio(first, "response-1");
        await fixture.waitForWriteStart(1);
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
        fixture.sendOutputAudio(queued, "response-1");
        fixture.sendOutputAudio(overflow, "response-1");

        await vi.waitFor(() => {
          expect(fixture.handleBargeIn).toHaveBeenCalledWith({
            audioPlaybackActive: true,
            force: true,
          });
        });
        fixture.callbacks.onClearAudio("barge-in");
        await vi.waitFor(() => {
          expect(fixture.clearOutput).toHaveBeenCalledOnce();
        });
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

        fixture.sendOutputAudio(late, "response-1");
        fixture.callbacks.onEvent?.({
          direction: "server",
          responseId: "response-1",
          type: terminalType,
        });
        fixture.sendOutputAudio(fresh, "response-2");
        fixture.releaseWrite(0);

        await fixture.waitForWriteStart(2);
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
        expect(fixture.clearOutput.mock.invocationCallOrder[1]).toBeLessThan(
          fixture.writeOutput.mock.invocationCallOrder[1] ?? 0,
        );
        expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
        fixture.releaseWrite(1);
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it("accepts a new response owner after backpressure without the stale response terminal", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.alloc(48_000, 1);
      const queued = Buffer.alloc(48_000, 2);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.sendOutputAudio(active, "response-1");
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      fixture.sendOutputAudio(queued, "response-1");
      fixture.sendOutputAudio(Buffer.from([5]), "response-1");
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
      });

      fixture.sendOutputAudio(late, "response-1");
      fixture.sendOutputAudio(fresh, "response-2");
      fixture.releaseWrite(0);

      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("holds anonymous backpressure output until the provider clear fence", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.alloc(48_000, 1);
      const queued = Buffer.alloc(48_000, 2);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.callbacks.onAudio(active);
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledOnce();
      fixture.callbacks.onAudio(queued);
      fixture.callbacks.onAudio(Buffer.from([5]));
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onAudio(late);
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(fresh);
      fixture.releaseWrite(0);

      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("bounds queued tiny-frame ownership", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.sendOutputAudio(Buffer.from([0]), "response-1");
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      for (let index = 1; index < 257; index += 1) {
        fixture.sendOutputAudio(Buffer.from([index]), "response-1");
      }

      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
      });
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("does not report a deferred cancellation race after response completion", async () => {
    const fixture = await createEngineFixture();
    try {
      const replacement = Buffer.from([4]);
      const late = Buffer.from([5]);
      const fresh = Buffer.from([6]);

      fixture.sendOutputAudio(Buffer.alloc(48_000, 1), "response-1");
      await fixture.waitForWriteStart(1);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      fixture.sendOutputAudio(Buffer.alloc(48_000, 2), "response-1");
      fixture.sendOutputAudio(Buffer.from([3]), "response-1");
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: "response-1",
        type: "response.done",
      });
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(replacement);
      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "error",
        detail: "Cancellation failed: no active response found",
      });
      expect(fixture.triggerHumanBargeIn()).toBe(true);
      fixture.sendOutputAudio(late);
      fixture.announceOutputResponse("response-3");
      fixture.sendOutputAudio(fresh);
      fixture.releaseWrite(0);

      expect(fixture.handle.getHealth().recentTalkEvents.map((event) => event.type)).not.toContain(
        "session.error",
      );
      await fixture.waitForWriteStart(2);
      expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(replacement);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });
});
