import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionMonitor,
  createConnectionMonitor,
  DEFAULT_CONFIG,
  formatConnectionState,
  type ConnectionMonitorConfig,
  type ConnectionState,
  type PingFunction,
  type ReconnectFunction,
} from "./connection-monitor.js";
import type { ResolvedBrowserProfile } from "./config.js";

describe("connection-monitor", () => {
  const mockProfile: ResolvedBrowserProfile = {
    name: "test-profile",
    cdpPort: 9222,
    cdpUrl: "http://localhost:9222",
    cdpHost: "localhost",
    cdpIsLoopback: true,
    color: "#FF0000",
    driver: "openclaw",
  };

  let pingFn: ReturnType<typeof vi.fn<PingFunction>>;
  let reconnectFn: ReturnType<typeof vi.fn<ReconnectFunction>>;

  beforeEach(() => {
    vi.useFakeTimers();
    pingFn = vi.fn<PingFunction>().mockResolvedValue(true);
    reconnectFn = vi.fn<ReconnectFunction>().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("ConnectionMonitor", () => {
    it("should create monitor with default config", () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      const state = monitor.getState();

      expect(state.connected).toBe(true);
      expect(state.reconnectAttempts).toBe(0);
      expect(monitor.isConnected()).toBe(true);
    });

    it("should create monitor with custom config", () => {
      const config: Partial<ConnectionMonitorConfig> = {
        heartbeatMs: 5000,
        maxRetries: 5,
      };
      
      const monitor = new ConnectionMonitor(
        mockProfile,
        pingFn,
        reconnectFn,
        config
      );

      expect(monitor).toBeDefined();
    });

    it("should start monitoring when enabled", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // Advance time to trigger first heartbeat
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      expect(pingFn).toHaveBeenCalledTimes(1);
    });

    it("should not start monitoring when disabled", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn, {
        enabled: false,
      });
      
      monitor.start();
      
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      expect(pingFn).not.toHaveBeenCalled();
    });

    it("should perform periodic heartbeats", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // First heartbeat
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      expect(pingFn).toHaveBeenCalledTimes(1);
      
      // Second heartbeat
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      expect(pingFn).toHaveBeenCalledTimes(2);
      
      // Third heartbeat
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      expect(pingFn).toHaveBeenCalledTimes(3);
      
      monitor.stop();
    });

    it("should update state after successful ping", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      const state = monitor.getState();
      
      expect(state.connected).toBe(true);
      expect(state.lastPing).toBeGreaterThan(0);
      expect(state.lastPong).toBeGreaterThan(0);
      expect(state.reconnectAttempts).toBe(0);
      
      monitor.stop();
    });

    it("should detect disconnection when ping fails", async () => {
      pingFn.mockResolvedValueOnce(false);
      
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      const state = monitor.getState();
      
      expect(state.connected).toBe(false);
      expect(state.lastError).toBeTruthy();
      
      monitor.stop();
    });

    it("should attempt reconnection on disconnection", async () => {
      // First ping fails
      pingFn.mockResolvedValueOnce(false);
      // Reconnection ping succeeds
      pingFn.mockResolvedValueOnce(true);
      
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // Trigger heartbeat (ping fails)
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      // Wait for reconnect delay
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      
      expect(reconnectFn).toHaveBeenCalledTimes(1);
      
      const state = monitor.getState();
      expect(state.connected).toBe(true);
      
      monitor.stop();
    });

    it("should limit reconnection attempts", async () => {
      // All pings fail
      pingFn.mockResolvedValue(false);
      
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn, {
        maxRetries: 2,
      });
      
      monitor.start();
      
      // First attempt
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      expect(reconnectFn).toHaveBeenCalledTimes(1);
      
      // Second attempt
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      expect(reconnectFn).toHaveBeenCalledTimes(2);
      
      // Third attempt should not happen (maxRetries: 2)
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      expect(reconnectFn).toHaveBeenCalledTimes(2);
    });

    it("should reset reconnect attempts after successful connection", async () => {
      // First ping fails, second succeeds
      pingFn.mockResolvedValueOnce(false).mockResolvedValue(true);
      
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // First heartbeat fails
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      
      let state = monitor.getState();
      expect(state.connected).toBe(true);
      expect(state.reconnectAttempts).toBe(0);
      
      // Next heartbeat should work normally
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      state = monitor.getState();
      expect(state.connected).toBe(true);
      expect(state.reconnectAttempts).toBe(0);
      
      monitor.stop();
    });

    it("should stop monitoring on demand", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // First heartbeat
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      expect(pingFn).toHaveBeenCalledTimes(1);
      
      monitor.stop();
      
      // No more heartbeats
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs * 3);
      expect(pingFn).toHaveBeenCalledTimes(1);
    });

    it("should handle ping exceptions", async () => {
      pingFn.mockRejectedValueOnce(new Error("Network error"));
      pingFn.mockResolvedValue(true);
      
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      
      // Heartbeat throws
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      // Check state immediately after disconnection (before reconnect)
      let state = monitor.getState();
      expect(state.connected).toBe(false);
      expect(state.lastError).toBeTruthy();
      expect(state.lastError?.includes("Network error")).toBe(true);
      
      // Wait for reconnection
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.retryDelayMs);
      
      // After reconnection, should be connected again
      state = monitor.getState();
      expect(state.connected).toBe(true);
      
      monitor.stop();
    });

    it("should calculate uptime correctly", () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      // Initially 100% uptime
      expect(monitor.getUptime()).toBe(100);
    });

    it("should not start twice", async () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.start();
      monitor.start(); // Should warn but not start twice
      
      await vi.advanceTimersByTimeAsync(DEFAULT_CONFIG.heartbeatMs);
      
      // Only one heartbeat timer should be active
      expect(pingFn).toHaveBeenCalledTimes(1);
      
      monitor.stop();
    });

    it("should allow config updates", () => {
      const monitor = new ConnectionMonitor(mockProfile, pingFn, reconnectFn);
      
      monitor.updateConfig({ heartbeatMs: 5000 });
      
      // Config should be updated
      // (Can't easily test the new interval without exposing internal state)
      expect(monitor).toBeDefined();
    });
  });

  describe("createConnectionMonitor", () => {
    it("should create a connection monitor instance", () => {
      const monitor = createConnectionMonitor(
        mockProfile,
        pingFn,
        reconnectFn
      );
      
      expect(monitor).toBeInstanceOf(ConnectionMonitor);
      expect(monitor.isConnected()).toBe(true);
    });

    it("should accept custom configuration", () => {
      const config: Partial<ConnectionMonitorConfig> = {
        heartbeatMs: 5000,
        maxRetries: 5,
      };
      
      const monitor = createConnectionMonitor(
        mockProfile,
        pingFn,
        reconnectFn,
        config
      );
      
      expect(monitor).toBeInstanceOf(ConnectionMonitor);
    });
  });

  describe("formatConnectionState", () => {
    it("should format connected state", () => {
      const state: ConnectionState = {
        connected: true,
        lastPing: Date.now(),
        lastPong: Date.now(),
        reconnectAttempts: 0,
        lastError: null,
      };
      
      const formatted = formatConnectionState(state);
      
      expect(formatted).toContain("✓ Connected");
      expect(formatted).toContain("Last ping:");
    });

    it("should format disconnected state", () => {
      const state: ConnectionState = {
        connected: false,
        lastPing: Date.now(),
        lastPong: null,
        reconnectAttempts: 2,
        lastError: "Connection timeout",
      };
      
      const formatted = formatConnectionState(state);
      
      expect(formatted).toContain("✗ Disconnected");
      expect(formatted).toContain("2 reconnect attempts");
    });

    it("should handle never-pinged state", () => {
      const state: ConnectionState = {
        connected: true,
        lastPing: null,
        lastPong: null,
        reconnectAttempts: 0,
        lastError: null,
      };
      
      const formatted = formatConnectionState(state);
      
      expect(formatted).toContain("never");
    });
  });
});
