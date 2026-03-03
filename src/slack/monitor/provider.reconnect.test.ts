import { describe, expect, it, vi } from "vitest";
import { __testing } from "./provider.js";
import { SLACK_SOCKET_DISCONNECT_GRACE_MS } from "./reconnect-policy.js";

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
  it("resolves disconnect waiter after disconnect grace period", async () => {
    vi.useFakeTimers();
    const client = new FakeEmitter();
    const app = { receiver: { client } };

    const waiter = __testing.waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");

    await vi.advanceTimersByTimeAsync(SLACK_SOCKET_DISCONNECT_GRACE_MS - 1);
    let settled = false;
    void waiter.then(() => {
      settled = true;
    });
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await expect(waiter).resolves.toEqual({ event: "disconnect" });
    vi.useRealTimers();
  });

  it("ignores transient disconnect when socket reconnects within grace period", async () => {
    vi.useFakeTimers();
    const client = new FakeEmitter();
    const app = { receiver: { client } };
    const err = new Error("later failure");

    const waiter = __testing.waitForSlackSocketDisconnect(app as never);
    client.emit("disconnected");
    await vi.advanceTimersByTimeAsync(Math.floor(SLACK_SOCKET_DISCONNECT_GRACE_MS / 2));
    client.emit("connected");
    await vi.advanceTimersByTimeAsync(SLACK_SOCKET_DISCONNECT_GRACE_MS);

    client.emit("error", err);
    await expect(waiter).resolves.toEqual({ event: "error", error: err });
    vi.useRealTimers();
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
