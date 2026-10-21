import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  startMeetingRealtimeEngine,
  type MeetingRealtimeToolCallParams,
} from "./realtime-engine.js";
import { createMeetingRealtimeOutputOwner } from "./realtime-output-owner.js";

it("retains the latest sixteen stale output responses and clears them on reset", () => {
  const owner = createMeetingRealtimeOutputOwner();
  for (let index = 0; index < 17; index++) {
    const responseId = `response-${index}`;
    expect(owner.accept(responseId)).toBe(true);
    owner.block();
    owner.terminal(responseId);
  }
  expect(owner.accept("response-1")).toBe(false);
  expect(owner.accept("response-0")).toBe(true);
  owner.reset();
  expect(owner.accept("response-1")).toBe(true);
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

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
    runtime: {} as never,
    tools: [],
    transport,
  });
  if (!callbacks) {
    throw new Error("Expected realtime voice bridge callbacks");
  }
  const bridgeCallbacks = callbacks;
  cleanups.push(() => handle.stop());
  const event = (type: string, responseId?: string, direction: "client" | "server" = "server") =>
    bridgeCallbacks.onEvent?.({ direction, type, ...(responseId ? { responseId } : {}) });
  return {
    event,
    closeBridge,
    disposeTransport,
    logger,
    stopTransport,
    beginOutput,
    callbacks: bridgeCallbacks,
    clearOutput,
    handle,
    handleBargeIn,
    submitToolResult,
    async waitForWriteStart(count: number) {
      await withTestTimeout(
        writeStart(count).promise,
        1_000,
        `Output write ${count} did not start`,
      );
      // Give detached work a turn without completing the write.
      await setImmediate();
    },
    async expectWrite(count: number, audio?: Buffer) {
      await this.waitForWriteStart(count);
      expect(writeOutput).toHaveBeenCalledTimes(count);
      if (audio) {
        expect(writeOutput).toHaveBeenLastCalledWith(audio);
      }
    },
    async overflowOutput() {
      this.sendOutputAudio(Buffer.alloc(48_000, 1), "response-1");
      await this.expectWrite(1);
      this.sendOutputAudio(Buffer.alloc(48_000, 2), "response-1");
      this.sendOutputAudio(Buffer.from([3]), "response-1");
      await vi.waitFor(() => expect(handleBargeIn).toHaveBeenCalledOnce());
    },
    releaseWrite(index: number) {
      const pending = pendingWrites[index];
      if (!pending) {
        throw new Error(`Expected pending output write ${index}`);
      }
      pending.resolve();
    },
    announceOutputResponse(responseId: string) {
      event("response.created", responseId);
    },
    sendOutputAudio(audio: Buffer, responseId?: string) {
      event("response.audio.delta", responseId);
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
  it("drains provider transcripts before rejected cleanup releases transport", async () => {
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
      providerClosed.reject(new Error("provider cleanup failed"));
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
  });

  it("finishes each response once and accepts a later response", async () => {
    const fixture = await createEngineFixture();
    fixture.callbacks.onTranscript?.("user", "first turn", true);
    fixture.announceOutputResponse("response-1");
    fixture.sendOutputAudio(Buffer.from([1]), "response-1");
    await fixture.expectWrite(1);
    fixture.callbacks.onResponseDone?.({
      status: "incomplete",
      responseId: "response-1",
      reason: "max_output_tokens",
      message: "provider response incomplete",
    });
    fixture.event("response.done", "response-1");

    const firstEvents = fixture.handle.getHealth().recentTalkEvents;
    expect(firstEvents.filter((event) => event.type === "turn.ended")).toHaveLength(1);
    expect(firstEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(1);
    expect(firstEvents.filter((event) => event.type === "session.error")).toHaveLength(1);
    expect(fixture.handle.getHealth().bridgeClosed).toBe(false);

    fixture.releaseWrite(0);
    fixture.callbacks.onTranscript?.("user", "later turn", true);
    fixture.announceOutputResponse("response-2");
    fixture.sendOutputAudio(Buffer.from([2]), "response-2");
    await fixture.expectWrite(2);
    fixture.callbacks.onResponseDone?.({ status: "completed", responseId: "response-2" });
    fixture.event("response.done", "response-2");

    const finalEvents = fixture.handle.getHealth().recentTalkEvents;
    expect(
      finalEvents.filter((event) => event.type === "turn.ended" || event.type === "turn.cancelled"),
    ).toHaveLength(2);
    expect(finalEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(2);
    fixture.releaseWrite(1);
  });

  it("rearms continuity reset when the provider creates a fresh session before ready", async () => {
    const fixture = await createEngineFixture();
    fixture.event("session.continuity.reset", undefined, "client");
    fixture.event("session.continuity.reset", undefined, "client");
    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledOnce());

    fixture.event("session.created");
    fixture.event("session.continuity.reset", undefined, "client");
    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledTimes(2));
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
    const active = Buffer.from([1]);
    const stale = Buffer.from([2]);
    const fresh = Buffer.from([3]);
    fixture.callbacks.onReady?.();
    fixture.callbacks.onTranscript?.("user", "old turn", true);
    fixture.sendOutputAudio(active, "response-1");
    await fixture.expectWrite(1);
    fixture.sendOutputAudio(stale, "response-1");
    fixture.callbacks.onToolCall?.({
      itemId: "item-old",
      callId: "call-old",
      name: "openclaw_agent_consult",
      args: { question: "old work" },
    });

    fixture.event("session.continuity.reset", undefined, "client");
    fixture.event("session.continuity.reset", undefined, "client");

    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledOnce());
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
    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledTimes(2));
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);

    fixture.callbacks.onReady?.();
    fixture.sendOutputAudio(fresh, "response-1");
    await fixture.expectWrite(2, fresh);
    fixture.releaseWrite(1);
  });

  it("serializes transport writes and coalesces queued 20 ms frames", async () => {
    const fixture = await createEngineFixture();
    const first = Buffer.alloc(960, 1);
    const queued = Array.from({ length: 30 }, (_, index) => Buffer.alloc(960, index + 2));

    fixture.callbacks.onAudio(first);
    for (const frame of queued) {
      fixture.callbacks.onAudio(frame);
    }
    await fixture.expectWrite(1, first);

    fixture.releaseWrite(0);
    await fixture.expectWrite(2, Buffer.concat(queued.slice(0, 25)));

    fixture.releaseWrite(1);
    await fixture.expectWrite(3, Buffer.concat(queued.slice(25)));
    fixture.releaseWrite(2);
  });

  it("accepts ordered provider output after a clear without a response owner", async () => {
    const fixture = await createEngineFixture();
    const stale = Buffer.from([1, 2, 3]);
    const fresh = Buffer.from([4, 5, 6]);

    fixture.callbacks.onAudio(stale);
    fixture.callbacks.onClearAudio("barge-in");
    fixture.callbacks.onAudio(fresh);

    await fixture.expectWrite(1);
    expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
    expect(fixture.clearOutput).toHaveBeenCalledOnce();
    expect(fixture.beginOutput).toHaveBeenCalledOnce();
    expect(fixture.beginOutput).toHaveBeenCalledAfter(fixture.clearOutput);
    fixture.releaseWrite(0);
  });

  it("invalidates queued output when human barge-in clears playback", async () => {
    const fixture = await createEngineFixture();
    const active = Buffer.from([1]);
    const stale = Buffer.from([2]);
    const late = Buffer.from([3]);
    const fresh = Buffer.from([4]);

    fixture.announceOutputResponse("response-1");
    fixture.sendOutputAudio(active);
    await fixture.expectWrite(1);
    fixture.sendOutputAudio(stale);

    expect(fixture.triggerHumanBargeIn()).toBe(true);
    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledOnce());
    fixture.sendOutputAudio(late);
    fixture.announceOutputResponse("response-2");
    fixture.sendOutputAudio(fresh);
    fixture.releaseWrite(0);

    await fixture.expectWrite(2, fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
    expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
    expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
    fixture.releaseWrite(1);
  });

  it("rejects a cleared response whose first audio arrives after barge-in", async () => {
    const fixture = await createEngineFixture();
    const stale = Buffer.from([1]);
    const fresh = Buffer.from([2]);

    fixture.announceOutputResponse("response-1");
    fixture.callbacks.onClearAudio("barge-in");
    fixture.callbacks.onAudio(stale);
    fixture.announceOutputResponse("response-2");
    fixture.callbacks.onAudio(fresh);

    await fixture.expectWrite(1);
    expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
    fixture.releaseWrite(0);
  });

  it("bounds queued bytes and rejects stale output through response.done", async () => {
    const fixture = await createEngineFixture();
    const first = Buffer.alloc(48_000, 1);
    const queued = Buffer.alloc(48_000, 2);
    const overflow = Buffer.from([3]);
    const late = Buffer.from([4]);
    const fresh = Buffer.from([5]);

    fixture.sendOutputAudio(first, "response-1");
    await fixture.expectWrite(1);
    fixture.sendOutputAudio(queued, "response-1");
    fixture.sendOutputAudio(overflow, "response-1");

    await vi.waitFor(() => {
      expect(fixture.handleBargeIn).toHaveBeenCalledWith({
        audioPlaybackActive: true,
        force: true,
      });
    });
    fixture.callbacks.onClearAudio("barge-in");
    await vi.waitFor(() => expect(fixture.clearOutput).toHaveBeenCalledOnce());
    expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

    fixture.sendOutputAudio(late, "response-1");
    fixture.event("response.done", "response-1");
    fixture.sendOutputAudio(fresh, "response-2");
    fixture.releaseWrite(0);

    await fixture.expectWrite(2, fresh);
    expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
    expect(fixture.clearOutput.mock.invocationCallOrder[1]).toBeLessThan(
      fixture.writeOutput.mock.invocationCallOrder[1] ?? 0,
    );
    expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
    fixture.releaseWrite(1);
  });

  it("accepts a new response owner after backpressure without the stale response terminal", async () => {
    const fixture = await createEngineFixture();
    const late = Buffer.from([3]);
    const fresh = Buffer.from([4]);

    await fixture.overflowOutput();
    expect(fixture.handleBargeIn).toHaveBeenCalledWith({
      audioPlaybackActive: true,
      force: true,
    });

    fixture.sendOutputAudio(late, "response-1");
    fixture.sendOutputAudio(fresh, "response-2");
    fixture.releaseWrite(0);

    await fixture.expectWrite(2, fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
    fixture.releaseWrite(1);
  });

  it("holds anonymous backpressure output until the provider clear fence", async () => {
    const fixture = await createEngineFixture();
    const active = Buffer.alloc(48_000, 1);
    const queued = Buffer.alloc(48_000, 2);
    const late = Buffer.from([3]);
    const fresh = Buffer.from([4]);

    fixture.callbacks.onAudio(active);
    await fixture.expectWrite(1);
    fixture.callbacks.onAudio(queued);
    fixture.callbacks.onAudio(Buffer.from([5]));
    await vi.waitFor(() => expect(fixture.handleBargeIn).toHaveBeenCalledOnce());

    fixture.callbacks.onAudio(late);
    fixture.callbacks.onClearAudio("barge-in");
    fixture.callbacks.onAudio(fresh);
    fixture.releaseWrite(0);

    await fixture.expectWrite(2, fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
    fixture.releaseWrite(1);
  });

  it("bounds queued tiny-frame ownership", async () => {
    const fixture = await createEngineFixture();
    fixture.sendOutputAudio(Buffer.from([0]), "response-1");
    await fixture.expectWrite(1);
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
  });

  it("does not report a deferred cancellation race after response completion", async () => {
    const fixture = await createEngineFixture();
    const replacement = Buffer.from([4]);
    const late = Buffer.from([5]);
    const fresh = Buffer.from([6]);

    await fixture.overflowOutput();

    fixture.event("response.done", "response-1");
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
    await fixture.expectWrite(2, fresh);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(replacement);
    expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
    fixture.releaseWrite(1);
  });
});
