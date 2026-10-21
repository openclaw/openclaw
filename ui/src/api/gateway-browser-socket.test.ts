/** @vitest-environment node */
import { getEventListeners } from "node:events";
import { DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserGatewaySocket } from "./gateway-browser-socket.ts";

type MockSocketEvent = { code?: number; data?: unknown; reason?: string };

const sockets: MockWebSocket[] = [];

class MockWebSocket extends EventTarget {
  static readonly OPEN = 1;
  readonly close = vi.fn((code?: number, _reason?: string) => {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException("invalid code", "InvalidAccessError");
    }
  });
  readyState = 0;

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(_data: string) {}

  emit(type: string, event: MockSocketEvent = {}) {
    this.dispatchEvent(Object.assign(new Event(type), event));
  }
}

function createHandlers() {
  return {
    open: vi.fn(),
    message: vi.fn(),
    close: vi.fn(),
    error: vi.fn(),
  };
}

describe("createBrowserGatewaySocket", () => {
  let socket: MockWebSocket;
  let handlers: ReturnType<typeof createHandlers>;
  let socketAdapter: ReturnType<typeof createBrowserGatewaySocket>;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
    vi.stubGlobal("WebSocket", MockWebSocket);
    handlers = createHandlers();
    socketAdapter = createBrowserGatewaySocket("wss://gateway.example", handlers);
    const created = sockets[0];
    if (!created) {
      throw new Error("expected a websocket instance");
    }
    socket = created;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("closes a websocket that never finishes opening", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error.mock.calls[0]?.[0]).toEqual(
      new Error(
        `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
      ),
    );
    expect(socket.close).toHaveBeenCalledOnce();

    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.close).toHaveBeenCalledWith(
      1006,
      `gateway websocket opening timed out after ${DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS}ms`,
    );
  });

  it("preserves a real close reason when an opening timeout also occurred", async () => {
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);
    socket.emit("close", { code: 1006, reason: "gateway supplied a close reason" });

    expect(handlers.close).toHaveBeenCalledWith(1006, "gateway supplied a close reason");
  });

  it("clears the opening deadline after the socket opens", async () => {
    socket.readyState = MockWebSocket.OPEN;
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.open).toHaveBeenCalledOnce();
    expect(handlers.error).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline after a native transport failure", async () => {
    socket.emit("error");
    socket.emit("close", { code: 1006, reason: "" });
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(handlers.error).toHaveBeenCalledOnce();
    expect(handlers.error).toHaveBeenCalledWith(new Error("websocket error"));
    expect(handlers.close).toHaveBeenCalledWith(1006, "");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("clears the opening deadline when the client closes the socket", async () => {
    socketAdapter.close(1000, "stopped");
    await vi.advanceTimersByTimeAsync(DEFAULT_PREAUTH_HANDSHAKE_TIMEOUT_MS);

    expect(socket.close).toHaveBeenCalledWith(1000, "stopped");
    expect(handlers.error).not.toHaveBeenCalled();

    socket.emit("close", { code: 1000, reason: "stopped" });
    expect(handlers.close).toHaveBeenCalledWith(1000, "stopped");
  });

  it("retires native listeners before delivering terminal close", () => {
    let retained: string[] | undefined;
    handlers.close.mockImplementation(() => {
      retained = ["open", "message", "close", "error"].filter(
        (type) => getEventListeners(socket, type).length > 0,
      );
    });

    socket.emit("close", { code: 1000, reason: "stopped" });

    expect(retained).toEqual([]);
  });

  it("maps protocol policy-violation closes to the browser-safe connect failure code", () => {
    expect(() => socketAdapter.close(1008, "connect failed")).not.toThrow();
    expect(socket.close).toHaveBeenCalledWith(4008, "connect failed");
  });
});
