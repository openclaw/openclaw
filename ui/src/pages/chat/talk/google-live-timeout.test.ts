// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  audioContexts,
  createTransport,
  googleLiveTestFixture,
  installGoogleLiveTestFixture,
  latestWebSocket,
} from "./google-live.test-support.ts";
import { GoogleLiveRealtimeTalkTransport } from "./google-live.ts";

const SETUP_TIMEOUT_MS = 30_000;
async function beginTransport(transport: GoogleLiveRealtimeTalkTransport) {
  const start = transport.start();
  await vi.advanceTimersByTimeAsync(0);
  return { start, socket: latestWebSocket() };
}

describe("Google Live setup timeout", () => {
  installGoogleLiveTestFixture();
  beforeEach(() => vi.useFakeTimers());

  afterEach(() => vi.useRealTimers());

  it("times out an open socket that never completes Google setup", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("does not publish provisional terminal callbacks when setup times out", async () => {
    const onStatus = vi.fn();
    const onTalkEvent = vi.fn(() => {
      throw new Error("talk callback must remain provisional");
    });
    const transport = await createTransport({ onStatus, onTalkEvent });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      throw new Error("status callback must remain provisional");
    });
    socket.readyState = 0;
    const rejected = expect(start).rejects.toThrow("Realtime connection timed out after 30000ms");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(onTalkEvent).not.toHaveBeenCalled();
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["close", "Realtime connection closed"],
    ["error", "Realtime connection failed"],
  ] as const)("rejects startup when the WebSocket emits %s", async (event, detail) => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    const rejected = expect(start).rejects.toThrow(detail);

    if (event === "close") {
      socket.emitClose();
    } else {
      socket.emitError();
    }

    await rejected;
    expect(onStatus).not.toHaveBeenCalled();
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases resources when a readiness callback throws during activation", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });
    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    onStatus.mockImplementation(() => {
      throw new Error("consumer failed");
    });
    socket.emitOpen();
    socket.emitJson({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");

    expect(() => transport.activate()).toThrow("consumer failed");
    expect(googleLiveTestFixture.stopInputTrack).toHaveBeenCalledOnce();
    expect(socket.readyState).toBe(3);
    expect(audioContexts.every((context) => context.close.mock.calls.length === 1)).toBe(true);
  });

  it("clears the deadline after Google setup completes", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start, socket } = await beginTransport(transport);
    onStatus.mockClear();
    socket.emitOpen();
    socket.emitJson({ setupComplete: {} });
    await expect(start).resolves.toBe("ready");
    expect(onStatus).not.toHaveBeenCalled();
    transport.activate();
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith("listening");
    transport.stop();
  });

  it("clears the deadline when the transport stops", async () => {
    const onStatus = vi.fn();
    const transport = await createTransport({ onStatus });

    const { start } = await beginTransport(transport);
    onStatus.mockClear();
    transport.stop();
    await expect(start).resolves.toBe("cancelled");
    await vi.advanceTimersByTimeAsync(SETUP_TIMEOUT_MS);

    expect(onStatus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
