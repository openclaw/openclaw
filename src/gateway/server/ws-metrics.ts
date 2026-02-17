import type { GatewayWsClient } from "./ws-types.js";

/**
 * WebSocket connection metrics for monitoring and observability.
 */
export interface WsConnectionMetrics {
  /** Total connections since server start */
  totalConnections: number;
  /** Currently active connections */
  activeConnections: number;
  /** Failed handshakes (timeout, auth failure, etc.) */
  failedHandshakes: number;
  /** Total messages received */
  messagesReceived: number;
  /** Total messages sent */
  messagesSent: number;
  /** Total bytes received (approximate) */
  bytesReceived: number;
  /** Total bytes sent (approximate) */
  bytesSent: number;
  /** Server start timestamp (ms since epoch) */
  startedAt: number;
  /** Average connection duration (ms) for closed connections */
  averageConnectionDurationMs: number;
  /** Peak concurrent connections */
  peakConnections: number;
}

/**
 * Per-client connection stats for detailed monitoring.
 */
export interface WsClientStats {
  connId: string;
  connectedAt: number;
  role: string;
  clientName: string;
  clientMode: string;
  platform?: string;
  messagesReceived: number;
  messagesSent: number;
  bytesReceived: number;
  bytesSent: number;
  lastActivityAt: number;
  latency?: number;
}

type ClosedConnectionStats = {
  durationMs: number;
};

/**
 * WebSocket metrics collector for Gateway.
 * Tracks connection lifecycle, message counts, and performance data.
 */
export class WsMetricsCollector {
  private totalConnections = 0;
  private failedHandshakes = 0;
  private messagesReceived = 0;
  private messagesSent = 0;
  private bytesReceived = 0;
  private bytesSent = 0;
  private peakConnections = 0;
  private closedConnections: ClosedConnectionStats[] = [];
  private readonly startedAt = Date.now();
  private readonly clientStats = new Map<string, WsClientStats>();

  /**
   * Get current metrics snapshot.
   */
  getMetrics(clients: Set<GatewayWsClient>): WsConnectionMetrics {
    const activeCount = clients.size;
    return {
      totalConnections: this.totalConnections,
      activeConnections: activeCount,
      failedHandshakes: this.failedHandshakes,
      messagesReceived: this.messagesReceived,
      messagesSent: this.messagesSent,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
      startedAt: this.startedAt,
      averageConnectionDurationMs: this.calculateAverageDuration(),
      peakConnections: this.peakConnections,
    };
  }

  /**
   * Get detailed stats for all connected clients.
   */
  getClientStats(): WsClientStats[] {
    return Array.from(this.clientStats.values());
  }

  /**
   * Record a new connection attempt.
   */
  onConnection(): void {
    this.totalConnections += 1;
  }

  /**
   * Record a successful handshake.
   * Called when client completes connect flow.
   */
  onHandshakeSuccess(client: GatewayWsClient): void {
    const connect = client.connect;
    const stats: WsClientStats = {
      connId: client.connId,
      connectedAt: Date.now(),
      role: connect.role ?? "operator",
      clientName: connect.client?.id ?? "unknown",
      clientMode: connect.client?.mode ?? "unknown",
      platform: connect.client?.platform,
      messagesReceived: 0,
      messagesSent: 0,
      bytesReceived: 0,
      bytesSent: 0,
      lastActivityAt: Date.now(),
    };
    this.clientStats.set(client.connId, stats);

    // Track peak connections
    const currentCount = this.clientStats.size;
    if (currentCount > this.peakConnections) {
      this.peakConnections = currentCount;
    }
  }

  /**
   * Record a failed handshake.
   */
  onHandshakeFailed(): void {
    this.failedHandshakes += 1;
  }

  /**
   * Record a connection close.
   */
  onDisconnect(connId: string): void {
    const stats = this.clientStats.get(connId);
    if (stats) {
      const durationMs = Date.now() - stats.connectedAt;
      this.closedConnections.push({ durationMs });

      // Keep only last 1000 closed connections for average calculation
      if (this.closedConnections.length > 1000) {
        this.closedConnections.shift();
      }

      this.clientStats.delete(connId);
    }
  }

  /**
   * Record a message received from client.
   */
  onMessageReceived(connId: string, byteSize: number): void {
    this.messagesReceived += 1;
    this.bytesReceived += byteSize;

    const stats = this.clientStats.get(connId);
    if (stats) {
      stats.messagesReceived += 1;
      stats.bytesReceived += byteSize;
      stats.lastActivityAt = Date.now();
    }
  }

  /**
   * Record a message sent to client.
   */
  onMessageSent(connId: string, byteSize: number): void {
    this.messagesSent += 1;
    this.bytesSent += byteSize;

    const stats = this.clientStats.get(connId);
    if (stats) {
      stats.messagesSent += 1;
      stats.bytesSent += byteSize;
      stats.lastActivityAt = Date.now();
    }
  }

  /**
   * Update latency for a client (RTT in ms).
   */
  updateLatency(connId: string, latencyMs: number): void {
    const stats = this.clientStats.get(connId);
    if (stats) {
      // Use exponential moving average for smoother latency tracking
      const alpha = 0.3;
      stats.latency = stats.latency
        ? Math.round(stats.latency * (1 - alpha) + latencyMs * alpha)
        : latencyMs;
    }
  }

  private calculateAverageDuration(): number {
    if (this.closedConnections.length === 0) {
      return 0;
    }
    const total = this.closedConnections.reduce((sum, c) => sum + c.durationMs, 0);
    return Math.round(total / this.closedConnections.length);
  }
}

// Singleton instance for the gateway
let metricsCollector: WsMetricsCollector | null = null;

/**
 * Get the global metrics collector instance.
 */
export function getWsMetricsCollector(): WsMetricsCollector {
  if (!metricsCollector) {
    metricsCollector = new WsMetricsCollector();
  }
  return metricsCollector;
}

/**
 * Reset the metrics collector (for testing).
 */
export function resetWsMetricsCollector(): void {
  metricsCollector = null;
}
