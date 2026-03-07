import { describe, expect, it, vi } from "vitest";
import { __testing } from "./provider.js";

class FakeEmitter {
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, listener: (...args: unknown[]) => void) {
    const bucket = this.listeners.get(event) ?? new Set<(...args: unknown[]) => void>();
    bucket.add(listener);
    this.listeners.set(event, bucket);
  }

  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

describe("slack socket reconnect helpers", () => {
  it("seeds event liveness when socket mode connects", () => {
    const setStatus = vi.fn();

    __testing.publishSlackConnectedStatus(setStatus);

    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        lastConnectedAt: expect.any(Number),
        lastEventAt: expect.any(Number),
        lastError: null,
      }),
    );
  });

  it("resolves disconnect waiter on socket disconnect event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };

    const waiter = __testing.waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await expect(waiter).resolves.toEqual({ event: "disconnect" });
  });

  it("resolves disconnect waiter on socket error event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("dns down");

    const waiter = __testing.waitForSlackSocketDisconnect(app as never);
    client.emit("error", err);

    await expect(waiter).resolves.toEqual({ event: "error", error: err });
  });

  it("preserves error payload from unable_to_socket_mode_start event", async () => {
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("invalid_auth");

    const waiter = __testing.waitForSlackSocketDisconnect(app as never);
    client.emit("unable_to_socket_mode_start", err);

    await expect(waiter).resolves.toEqual({
      event: "unable_to_socket_mode_start",
      error: err,
    });
  });
});
