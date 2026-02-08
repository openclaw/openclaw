/**
 * Connection Monitoring & Auto-Reconnect
 * 
 * Monitors browser connection health and automatically reconnects on disconnect.
 * Sends periodic heartbeat pings to detect connection issues early.
 */

import type { ResolvedBrowserProfile } from "./config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("connection-monitor");

export type ConnectionMonitorConfig = {
  /** Enable connection monitoring */
  enabled: boolean;
  /** Heartbeat interval in milliseconds */
  heartbeatMs: number;
  /** Enable automatic reconnection */
  autoReconnect: boolean;
  /** Maximum reconnection attempts */
  maxRetries: number;
  /** Delay between reconnection attempts (ms) */
  retryDelayMs: number;
};

export type ConnectionState = {
  connected: boolean;
  lastPing: number | null;
  lastPong: number | null;
  reconnectAttempts: number;
  lastError: string | null;
};

export type PingFunction = () => Promise<boolean>;
export type ReconnectFunction = () => Promise<void>;

export const DEFAULT_CONFIG: ConnectionMonitorConfig = {
  enabled: true,
  heartbeatMs: 10000, // 10 seconds
  autoReconnect: true,
  maxRetries: 3,
  retryDelayMs: 5000, // 5 seconds
};

/**
 * Connection Monitor
 * 
 * Manages heartbeat and reconnection logic for a browser connection.
 */
export class ConnectionMonitor {
  private config: ConnectionMonitorConfig;
  private profile: ResolvedBrowserProfile;
  private state: ConnectionState;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pingFn: PingFunction;
  private reconnectFn: ReconnectFunction;
  private running = false;

  constructor(
    profile: ResolvedBrowserProfile,
    pingFn: PingFunction,
    reconnectFn: ReconnectFunction,
    config: Partial<ConnectionMonitorConfig> = {}
  ) {
    this.profile = profile;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.pingFn = pingFn;
    this.reconnectFn = reconnectFn;
    this.state = {
      connected: true,
      lastPing: null,
      lastPong: null,
      reconnectAttempts: 0,
      lastError: null,
    };
  }

  /**
   * Start monitoring connection
   */
  start(): void {
    if (!this.config.enabled) {
      log.debug(`[${this.profile.name}] Connection monitoring disabled`);
      return;
    }

    if (this.running) {
      log.warn(`[${this.profile.name}] Connection monitor already running`);
      return;
    }

    this.running = true;
    this.scheduleHeartbeat();
    log.info(
      `[${this.profile.name}] Connection monitor started (heartbeat: ${this.config.heartbeatMs}ms)`
    );
  }

  /**
   * Stop monitoring connection
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    log.info(`[${this.profile.name}] Connection monitor stopped`);
  }

  /**
   * Schedule next heartbeat
   */
  private scheduleHeartbeat(): void {
    if (!this.running) {
      return;
    }

    this.heartbeatTimer = setTimeout(() => {
      this.performHeartbeat();
    }, this.config.heartbeatMs);
  }

  /**
   * Perform heartbeat check
   */
  private async performHeartbeat(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.state.lastPing = Date.now();

    try {
      const success = await this.pingFn();

      if (success) {
        this.state.lastPong = Date.now();
        this.state.connected = true;
        this.state.reconnectAttempts = 0;
        this.state.lastError = null;
        
        log.debug(
          `[${this.profile.name}] Heartbeat OK (latency: ${
            this.state.lastPong - this.state.lastPing
          }ms)`
        );
      } else {
        // Ping failed
        await this.handleDisconnection("Ping returned false");
      }
    } catch (err) {
      // Ping threw error
      await this.handleDisconnection(String(err));
    }

    // Schedule next heartbeat
    this.scheduleHeartbeat();
  }

  /**
   * Handle connection loss
   */
  private async handleDisconnection(reason: string): Promise<void> {
    this.state.connected = false;
    this.state.lastError = reason;

    log.warn(
      `[${this.profile.name}] Connection lost: ${reason} (attempt ${
        this.state.reconnectAttempts + 1
      }/${this.config.maxRetries})`
    );

    // Check if should auto-reconnect
    if (
      this.config.autoReconnect &&
      this.state.reconnectAttempts < this.config.maxRetries
    ) {
      this.state.reconnectAttempts++;

      // Wait before reconnecting
      await this.sleep(this.config.retryDelayMs);

      // Attempt reconnection
      try {
        log.info(`[${this.profile.name}] Attempting reconnection...`);
        await this.reconnectFn();
        
        // Test connection
        const success = await this.pingFn();
        
        if (success) {
          this.state.connected = true;
          this.state.reconnectAttempts = 0;
          this.state.lastError = null;
          log.info(`[${this.profile.name}] Reconnection successful`);
        } else {
          log.warn(`[${this.profile.name}] Reconnection ping failed`);
        }
      } catch (err) {
        log.error(
          `[${this.profile.name}] Reconnection failed: ${String(err)}`
        );
      }
    } else if (this.state.reconnectAttempts >= this.config.maxRetries) {
      log.error(
        `[${this.profile.name}] Max reconnection attempts reached (${this.config.maxRetries})`
      );
      this.stop();
    }
  }

  /**
   * Get current connection state
   */
  getState(): Readonly<ConnectionState> {
    return { ...this.state };
  }

  /**
   * Check if currently connected
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  /**
   * Get connection uptime percentage (last 100 pings)
   */
  getUptime(): number {
    // This is a simplified calculation
    // In production, you'd track a rolling window of ping results
    if (this.state.lastError) {
      return this.state.connected ? 95 : 0;
    }
    return 100;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<ConnectionMonitorConfig>): void {
    this.config = { ...this.config, ...config };
    
    // Restart if running
    if (this.running) {
      this.stop();
      this.start();
    }
  }
}

/**
 * Create a connection monitor instance
 */
export function createConnectionMonitor(
  profile: ResolvedBrowserProfile,
  pingFn: PingFunction,
  reconnectFn: ReconnectFunction,
  config?: Partial<ConnectionMonitorConfig>
): ConnectionMonitor {
  return new ConnectionMonitor(profile, pingFn, reconnectFn, config);
}

/**
 * Format connection state for logging
 */
export function formatConnectionState(state: ConnectionState): string {
  const status = state.connected ? "✓ Connected" : "✗ Disconnected";
  const lastPing = state.lastPing
    ? new Date(state.lastPing).toLocaleTimeString()
    : "never";
  const attempts = state.reconnectAttempts > 0
    ? ` (${state.reconnectAttempts} reconnect attempts)`
    : "";
  
  return `${status} - Last ping: ${lastPing}${attempts}`;
}
