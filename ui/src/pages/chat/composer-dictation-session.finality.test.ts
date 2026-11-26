// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { ComposerDictationSession } from "./composer-dictation-session.ts";
import { audioFixture, MockDictationAudioContext } from "./talk/input.test-support.ts";

type GatewayListener = (frame: GatewayEventFrame) => void;
const sessions: ComposerDictationSession[] = [];

function fixture(options: { closePending?: boolean } = {}) {
  const listeners = new Set<GatewayListener>();
  const media = audioFixture();
  let settleClose = () => {};
  const close = new Promise<void>((resolve) => {
    settleClose = resolve;
  });
  const request = vi.fn(async (method: string) => {
    if (method === "talk.session.create") {
      return {
        sessionId: "capture",
        transcriptionSessionId: "capture",
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      };
    }
    if (method === "talk.session.close" && options.closePending) {
      await close;
    }
    return { ok: true };
  });
  const client = {
    request,
    addEventListener: (listener: GatewayListener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GatewayBrowserClient;
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => media.stream) },
  });
  const onError = vi.fn();
  const session = new ComposerDictationSession(client, {
    onError,
    onReady: () => undefined,
    onTranscriptChange: () => undefined,
  });
  sessions.push(session);
  const emit = (
    type: "partial" | "transcript" | "close" | "error",
    text: string,
    sequence: number,
    turnId = "turn-1",
  ) => {
    const payload = {
      transcriptionSessionId: "capture",
      type,
      text,
      ...(type === "transcript" ? { final: true } : {}),
      ...(type === "close" ? { reason: "completed" } : {}),
      ...(type === "error" ? { message: "Synthetic provider failure" } : {}),
      talkEvent: {
        id: `capture:${sequence}`,
        sessionId: "capture",
        seq: sequence,
        turnId,
        type:
          type === "partial"
            ? "transcript.delta"
            : type === "transcript"
              ? "transcript.done"
              : type === "close"
                ? "session.closed"
                : "session.error",
      },
    };
    for (const listener of listeners) {
      listener({ event: "talk.event", payload } as GatewayEventFrame);
    }
  };
  return { session, media, request, emit, listeners, onError, settleClose };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioContext", MockDictationAudioContext);
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    void session.cancel();
  }
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("dictation finality at the capture owner", () => {
  it("releases capture immediately and accepts one clean final after Stop", async () => {
    const h = fixture();
    await h.session.start();
    h.emit("partial", "Do not", 1);
    const result = h.session.finishSnapshot();
    expect(h.media.track.stop).toHaveBeenCalledOnce();
    h.emit("transcript", "Do not delete the backup.", 2);
    h.emit("transcript", "Do not delete the backup.", 2);
    h.emit("partial", "obsolete partial", 1);
    h.emit("partial", "late partial for completed turn", 3);
    h.emit("close", "", 4);

    await expect(result).resolves.toMatchObject({
      text: "Do not delete the backup.",
      revision: 2,
      isFinal: true,
      incompleteText: "",
      reason: "complete",
    });
    expect(h.listeners.size).toBe(0);
    expect(h.onError).not.toHaveBeenCalled();
  });

  it("keeps repeated spoken text from different turns while rejecting stale turn events", async () => {
    const h = fixture();
    await h.session.start();
    h.emit("transcript", "Yes.", 2);
    h.emit("partial", "stale", 1);
    const result = h.session.finishSnapshot();
    h.emit("transcript", "Yes.", 4, "turn-2");
    h.emit("close", "", 5);
    await expect(result).resolves.toMatchObject({ text: "Yes. Yes.", isFinal: true, revision: 2 });
  });

  it.each(["timeout", "error", "disconnected"] as const)(
    "does not certify a final prefix as the complete utterance after %s",
    async (reason) => {
      const h = fixture({ closePending: true });
      await h.session.start();
      h.emit("transcript", "I can", 1);
      const result = h.session.finishSnapshot();
      if (reason === "timeout") {
        await vi.advanceTimersByTimeAsync(10_000);
      } else if (reason === "error") {
        h.emit("error", "", 2);
      } else {
        h.session.markGatewayDisconnected();
      }
      await expect(result).resolves.toMatchObject({
        text: "I can",
        isFinal: false,
        incompleteText: "I can",
        reason,
      });
      expect(h.listeners.size).toBe(0);
      h.settleClose();
    },
  );

  it("keeps partial-only and unfinished trailing captions in manual recovery", async () => {
    const h = fixture();
    await h.session.start();
    h.emit("partial", "Do not", 1);
    const result = h.session.finishSnapshot();
    h.emit("close", "", 2);
    await expect(result).resolves.toMatchObject({
      text: "",
      isFinal: false,
      incompleteText: "Do not",
      reason: "complete",
    });

    const trailing = fixture();
    await trailing.session.start();
    trailing.emit("transcript", "Keep the backup.", 1);
    const pending = trailing.session.finishSnapshot();
    trailing.emit("partial", "Do not", 2, "turn-2");
    trailing.emit("close", "", 3);
    await expect(pending).resolves.toMatchObject({
      text: "Keep the backup.",
      isFinal: false,
      incompleteText: "Keep the backup. Do not",
    });
  });

  it("aborts the drain without waiting for remote close and cannot revive from a late final", async () => {
    const h = fixture({ closePending: true });
    await h.session.start();
    h.emit("partial", "private unfinished words", 1);
    const controller = new AbortController();
    const result = h.session.finishSnapshot({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(result).resolves.toMatchObject({
      text: "",
      incompleteText: "",
      isFinal: false,
      reason: "cancelled",
    });
    expect(h.listeners.size).toBe(0);
    h.emit("transcript", "late result", 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.request).toHaveBeenCalledWith(
      "talk.session.close",
      { sessionId: "capture", discard: true },
      { timeoutMs: 10_000 },
    );
    h.settleClose();
  });

  it("retains the disabled baseline's partial-recovery behavior", async () => {
    const h = fixture();
    await h.session.start();
    h.emit("partial", "Editable incomplete caption", 1);
    const result = h.session.finish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe("Editable incomplete caption");
    expect(h.request).toHaveBeenCalledWith(
      "talk.session.close",
      { sessionId: "capture" },
      { timeoutMs: null },
    );
  });
});
