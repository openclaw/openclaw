import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommonlyWebSocket } from "./websocket.js";

// Mock socket.io-client
const mockSocket = {
  connected: false,
  on: vi.fn(),
  off: vi.fn(),
  once: vi.fn(),
  emit: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("socket.io-client", () => ({
  io: vi.fn(() => mockSocket),
}));

describe("CommonlyWebSocket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSocket.connected = false;
    // Reset mock implementations
    mockSocket.on.mockImplementation(() => mockSocket);
    mockSocket.once.mockImplementation((event: string, handler: () => void) => {
      if (event === "connect") {
        // Simulate immediate connection
        setTimeout(() => handler(), 0);
      }
      return mockSocket;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("subscribe", () => {
    it("stores subscribed podIds for re-subscription", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      await ws.connect();
      ws.subscribe(["pod-1", "pod-2"]);

      expect(mockSocket.emit).toHaveBeenCalledWith("subscribe", {
        podIds: ["pod-1", "pod-2"],
      });
    });

    it("deduplicates podIds when subscribing multiple times", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      await ws.connect();
      ws.subscribe(["pod-1", "pod-2"]);
      ws.subscribe(["pod-2", "pod-3"]);

      // Second subscribe should include pod-3 but stored list should be deduplicated
      expect(mockSocket.emit).toHaveBeenCalledTimes(2);
      expect(mockSocket.emit).toHaveBeenLastCalledWith("subscribe", {
        podIds: ["pod-2", "pod-3"],
      });
    });
  });

  describe("unsubscribe", () => {
    it("removes podIds from stored list", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      await ws.connect();
      ws.subscribe(["pod-1", "pod-2", "pod-3"]);
      ws.unsubscribe(["pod-2"]);

      expect(mockSocket.emit).toHaveBeenLastCalledWith("unsubscribe", {
        podIds: ["pod-2"],
      });
    });
  });

  describe("reconnection", () => {
    it("re-subscribes to pods on reconnect", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      // Capture the connect handler
      let connectHandler: (() => void) | null = null;
      mockSocket.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "connect") {
          connectHandler = handler;
        }
        return mockSocket;
      });

      await ws.connect();
      ws.subscribe(["pod-1", "pod-2"]);

      // Clear emit calls from initial subscribe
      mockSocket.emit.mockClear();

      // Simulate reconnect by calling the connect handler again
      if (connectHandler) {
        connectHandler();
      }

      // Should re-subscribe to stored pods
      expect(mockSocket.emit).toHaveBeenCalledWith("subscribe", {
        podIds: ["pod-1", "pod-2"],
      });
    });

    it("does not re-subscribe if no pods were subscribed", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      let connectHandler: (() => void) | null = null;
      mockSocket.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "connect") {
          connectHandler = handler;
        }
        return mockSocket;
      });

      await ws.connect();

      // Clear any calls from connection
      mockSocket.emit.mockClear();

      // Simulate reconnect
      if (connectHandler) {
        connectHandler();
      }

      // Should not emit subscribe since no pods were subscribed
      expect(mockSocket.emit).not.toHaveBeenCalledWith(
        "subscribe",
        expect.anything(),
      );
    });
  });

  describe("ping/pong", () => {
    it("responds to ping with pong", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      // Capture the ping handler
      let pingHandler: (() => void) | null = null;
      mockSocket.on.mockImplementation((event: string, handler: () => void) => {
        if (event === "ping") {
          pingHandler = handler;
        }
        return mockSocket;
      });

      await ws.connect();

      // Simulate receiving a ping
      if (pingHandler) {
        mockSocket.emit.mockClear();
        pingHandler();
      }

      expect(mockSocket.emit).toHaveBeenCalledWith("pong");
    });
  });

  describe("disconnect", () => {
    it("clears socket on disconnect", async () => {
      const ws = new CommonlyWebSocket({
        baseUrl: "http://localhost:5000",
        runtimeToken: "test-token",
      });

      await ws.connect();
      ws.disconnect();

      expect(mockSocket.disconnect).toHaveBeenCalled();
      expect(ws.isConnected()).toBe(false);
    });
  });
});
