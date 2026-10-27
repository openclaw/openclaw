import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createRealtimeVoiceAudioQueue,
  RealtimeVoiceSessionLifecycle,
  type RealtimeVoiceBrowserSessionCreateRequest,
  type RealtimeVoiceGatewayControl,
  type RealtimeVoiceSessionConnection,
} from "./realtime-voice.js";

it("requires command binding only for negotiated Gateway control", () => {
  type Base = { providerConfig: Record<string, unknown> };
  type Claim = { clientControl: { owner: "gateway" } };
  type Legacy = Base & { gatewayControl: Pick<RealtimeVoiceGatewayControl, "bindBridge"> };
  type Controlled = Base &
    Claim & {
      gatewayControl: RealtimeVoiceGatewayControl &
        Required<Pick<RealtimeVoiceGatewayControl, "bindControl">>;
    };

  expectTypeOf<Base>().toMatchTypeOf<RealtimeVoiceBrowserSessionCreateRequest>();
  expectTypeOf<Legacy>().toMatchTypeOf<RealtimeVoiceBrowserSessionCreateRequest>();
  expectTypeOf<Controlled>().toMatchTypeOf<RealtimeVoiceBrowserSessionCreateRequest>();
  expectTypeOf<Base & Claim>().not.toMatchTypeOf<RealtimeVoiceBrowserSessionCreateRequest>();
  expectTypeOf<Legacy & Claim>().not.toMatchTypeOf<RealtimeVoiceBrowserSessionCreateRequest>();
});

function connectLifecycle(
  lifecycle: RealtimeVoiceSessionLifecycle,
): RealtimeVoiceSessionConnection {
  let connection: RealtimeVoiceSessionConnection | undefined;
  void lifecycle.connect(async (current) => {
    connection = current;
  });
  return expectDefined(connection, "synchronous connection ownership");
}

describe("RealtimeVoiceSessionLifecycle", () => {
  let lifecycle: RealtimeVoiceSessionLifecycle;
  beforeEach(() => {
    lifecycle = new RealtimeVoiceSessionLifecycle("Test");
  });
  it("terminalizes preconnect cancellation until an explicit fresh connection", () => {
    expect(lifecycle.phase()).toBe("idle");
    expect(lifecycle.isReady()).toBe(false);
    expect(lifecycle.cancel()).toBe(true);
    expect(lifecycle.phase()).toBe("terminal");
    expect(lifecycle.cancel()).toBe(false);

    const connection = connectLifecycle(lifecycle);
    expect(lifecycle.phase()).toBe("connecting");
    expect(lifecycle.ready(connection)).toBe(true);
    expect(lifecycle.phase()).toBe("ready");
  });

  it("owns retry attempts and resets them only after provider readiness", () => {
    let connection = connectLifecycle(lifecycle);
    for (const attempt of [1, 2]) {
      expect(lifecycle.retry(connection, 2)).toMatchObject({ attempt });
      expect(lifecycle.acceptsEvents(connection)).toBe(false);
      expect(lifecycle.retry(connection, 2)).toBeUndefined();
      connection = expectDefined(lifecycle.reconnect(connection), "retry connection");
    }
    expect(lifecycle.retry(connection, 2)).toBe("exhausted");
    expect(lifecycle.ready(connection)).toBe(true);
    expect(lifecycle.retry(connection, 2)).toMatchObject({ attempt: 1 });
  });

  it("ignores stale connections and aborts explicit replacements", async () => {
    const first = connectLifecycle(lifecycle);
    lifecycle.retry(first, 1);
    const retry = expectDefined(lifecycle.reconnect(first), "retry connection");

    expect(lifecycle.ready(first)).toBe(false);
    expect(lifecycle.close(first, "error")).toBeUndefined();
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.ready(retry)).toBe(true);

    expect(lifecycle.retry(retry, 1)).toMatchObject({ attempt: 1 });
    await Promise.resolve();
    const replacement = connectLifecycle(lifecycle);
    expect(retry.signal).toMatchObject({
      aborted: true,
      reason: new Error("Test realtime voice connection replaced"),
    });
    expect(lifecycle.failure(retry)).toBe(false);
    expect(lifecycle.ready(replacement)).toBe(true);
  });

  it("keeps terminal outcomes authoritative and notifies once", () => {
    const canceled = new RealtimeVoiceSessionLifecycle("Test");
    const canceledConnection = connectLifecycle(canceled);

    expect(canceled.cancel()).toBe(true);
    expect(canceledConnection.signal.aborted).toBe(true);
    expect(canceled.acceptsEvents(canceledConnection)).toBe(false);
    expect(canceled.cancel()).toBe(false);
    expect(canceled.failure(canceledConnection)).toBe(false);
    expect(canceled.terminalOutcome(canceledConnection)).toBe("completed");
    expect(canceled.close(canceledConnection, "error")).toBe("completed");
    expect(canceled.close(canceledConnection, "completed")).toBeUndefined();

    const failed = new RealtimeVoiceSessionLifecycle("Test");
    const failedConnection = connectLifecycle(failed);
    expect(failed.failure(failedConnection)).toBe(true);
    expect(failed.cancel()).toBe(false);
    expect(failed.close(failedConnection, "completed")).toBe("error");
    expect(failed.close(failedConnection, "error")).toBeUndefined();
  });

  it("coalesces connects and lets cancellation immediately transfer ownership", async () => {
    const setup = createDeferred();
    const firstStarted = vi.fn((connection: RealtimeVoiceSessionConnection) => {
      connection.signal.addEventListener("abort", () => setup.reject(connection.signal.reason), {
        once: true,
      });
      return setup.promise;
    });
    const secondStarted = vi.fn();
    const first = lifecycle.connect(firstStarted);
    const coalesced = lifecycle.connect(async () => {
      secondStarted();
    });

    expect(coalesced).toBe(first);
    expect(firstStarted).toHaveBeenCalledOnce();
    expect(secondStarted).not.toHaveBeenCalled();
    expect(lifecycle.cancel()).toBe(true);

    const replacement = lifecycle.connect(async (connection) => {
      expect(connection).not.toBe(firstStarted.mock.calls[0]?.[0]);
      secondStarted();
    });
    await replacement;
    await expect(first).rejects.toThrow("Test realtime voice session canceled");
    expect(secondStarted).toHaveBeenCalledOnce();
  });

  it("exposes cancellation to async setup before it can create a late transport", async () => {
    const credentials = createDeferred();
    const openTransport = vi.fn();

    const connecting = lifecycle.connect(async (connection) => {
      await credentials.promise;
      if (!connection.signal.aborted) {
        openTransport();
      }
    });
    lifecycle.cancel();
    credentials.resolve();
    await connecting;

    expect(openTransport).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "settles connect attempts and releases ownership (ready=%s)",
    async (ready) => {
      vi.useFakeTimers();
      try {
        const onAbort = vi.fn();
        const onTimeout = vi.fn();
        const attempt = lifecycle.createConnectAttempt({
          connection: connectLifecycle(lifecycle),
          onAbort,
          onTimeout,
          timeoutError: () => new Error("timed out"),
          timeoutMs: 10,
        });
        if (ready) {
          attempt.startTimeout();
          attempt.resolve(true);
          attempt.reject(new Error("late failure"));
          await expect(attempt.promise).resolves.toBeUndefined();
          await vi.advanceTimersByTimeAsync(10);
          lifecycle.cancel();
          expect(attempt).toMatchObject({ ready: true, settled: true });
          expect(onTimeout).not.toHaveBeenCalled();
          expect(onAbort).not.toHaveBeenCalled();
        } else {
          const rejected = expect(attempt.promise).rejects.toThrow("timed out");
          await vi.advanceTimersByTimeAsync(10);
          expect(onTimeout).not.toHaveBeenCalled();
          attempt.startTimeout();
          attempt.startTimeout();
          await vi.advanceTimersByTimeAsync(10);
          await rejected;
          expect(attempt.startupFailed).toBe(true);
          expect(onTimeout).toHaveBeenCalledOnce();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("owns copied pending audio and clears it at terminal boundaries", () => {
    const backing = Buffer.alloc(2 * 1024 * 1024, 0x01);
    const view = backing.subarray(0, 512 * 1024);

    expect(lifecycle.enqueuePendingAudio(view)).toBe(true);
    view.fill(0);
    expect(lifecycle.enqueuePendingAudio(Buffer.alloc(512 * 1024, 0x02))).toBe(true);
    expect(lifecycle.enqueuePendingAudio(Buffer.from([0x03]))).toBe(false);
    expect(lifecycle.drainPendingAudio()).toEqual([
      Buffer.alloc(512 * 1024, 0x01),
      Buffer.alloc(512 * 1024, 0x02),
    ]);

    const small = Buffer.alloc(960, 0x03);
    lifecycle.enqueuePendingAudio(small);
    small.fill(0);
    const [retained] = lifecycle.drainPendingAudio();
    expect(retained).toEqual(Buffer.alloc(960, 0x03));
    expect(retained?.buffer.byteLength).toBe(960);

    lifecycle.enqueuePendingAudio(Buffer.from([0x04]));
    lifecycle.cancel();
    expect(lifecycle.drainPendingAudio()).toEqual([]);
  });

  it("keeps the freshest queued speech and warns once per overflow episode", () => {
    const onPendingAudioOverflow = vi.fn();
    lifecycle = new RealtimeVoiceSessionLifecycle("Test", {
      pendingAudioOverflowPolicy: "drop-oldest",
      onPendingAudioOverflow,
    });

    for (let index = 0; index < 322; index += 1) {
      expect(lifecycle.enqueuePendingAudio(Buffer.from([index % 256]))).toBe(true);
    }
    expect(onPendingAudioOverflow).toHaveBeenCalledOnce();
    expect(lifecycle.drainPendingAudio()).toEqual(
      Array.from({ length: 320 }, (_, index) => Buffer.from([(index + 2) % 256])),
    );

    for (let index = 0; index < 321; index += 1) {
      lifecycle.enqueuePendingAudio(Buffer.from([index % 256]));
    }
    expect(onPendingAudioOverflow).toHaveBeenCalledTimes(2);
  });
});

describe("createRealtimeVoiceAudioQueue", () => {
  it("releases byte budget as queued audio is consumed", () => {
    const queue = createRealtimeVoiceAudioQueue("reject-newest");
    const first = Buffer.alloc(512 * 1024, 0x01);
    const second = Buffer.alloc(512 * 1024, 0x02);

    expect(queue.enqueue(first)).toBe(true);
    expect(queue.enqueue(second)).toBe(true);
    expect(queue.enqueue(Buffer.from([0x03]))).toBe(false);
    expect(queue.dequeue()).toEqual(first);
    expect(queue.enqueue(Buffer.from([0x03]))).toBe(true);
    expect(queue.drain()).toEqual([second, Buffer.from([0x03])]);
  });

  it("resets audio queue accounting on clear", () => {
    const queue = createRealtimeVoiceAudioQueue("drop-oldest");
    expect(queue.enqueue(Buffer.alloc(1024 * 1024, 0x04))).toBe(true);
    queue.clear();
    expect(queue.enqueue(Buffer.from([0x05]))).toBe(true);
    expect(queue.drain()).toEqual([Buffer.from([0x05])]);
  });
});
