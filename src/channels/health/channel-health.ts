/**
 * Channel health monitoring interface and registry.
 *
 * Provides unified health status tracking for all channel adapters.
 */

import { getChildLogger } from "../../logging/logger.js";

const log = getChildLogger({ subsystem: "channel-health" });

export type ChannelHealthStatus = "healthy" | "degraded" | "unhealthy" | "unknown";

export interface ChannelHealth {
  /** Channel identifier (telegram, discord, etc.) */
  channel: string;
  /** Current health status */
  status: ChannelHealthStatus;
  /** Last successful heartbeat timestamp */
  lastHeartbeat: Date | null;
  /** Number of consecutive failures */
  consecutiveFailures: number;
  /** Last measured latency in milliseconds */
  latencyMs: number | null;
  /** Last error message if unhealthy */
  error?: string;
  /** Additional channel-specific metadata */
  metadata?: Record<string, unknown>;
}

export interface ChannelHealthProvider {
  /** Channel identifier */
  readonly channel: string;
  /** Perform health check and return status */
  heartbeat(): Promise<ChannelHealth>;
  /** Get cached status without performing check */
  getStatus(): ChannelHealth;
  /** Start periodic health checks */
  startMonitoring?(intervalMs: number): void;
  /** Stop periodic health checks */
  stopMonitoring?(): void;
}

export interface ChannelHealthRegistry {
  /** Register a channel health provider */
  register(provider: ChannelHealthProvider): void;
  /** Unregister a channel */
  unregister(channel: string): void;
  /** Get all registered channels */
  getAll(): ChannelHealth[];
  /** Get health for specific channel */
  getByChannel(channel: string): ChannelHealth | null;
  /** Perform heartbeat on all channels */
  heartbeatAll(): Promise<ChannelHealth[]>;
  /** Get summary status */
  getSummary(): ChannelHealthSummary;
}

export interface ChannelHealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  unhealthy: number;
  unknown: number;
  lastCheck: Date | null;
}

/**
 * Create a channel health registry for aggregating health across adapters.
 */
export function createChannelHealthRegistry(): ChannelHealthRegistry {
  const providers = new Map<string, ChannelHealthProvider>();
  let lastCheck: Date | null = null;

  return {
    register(provider: ChannelHealthProvider): void {
      if (providers.has(provider.channel)) {
        log.warn(`Replacing existing health provider for channel: ${provider.channel}`);
      }
      providers.set(provider.channel, provider);
      log.info(`Registered health provider for channel: ${provider.channel}`);
    },

    unregister(channel: string): void {
      const provider = providers.get(channel);
      if (provider) {
        provider.stopMonitoring?.();
        providers.delete(channel);
        log.info(`Unregistered health provider for channel: ${channel}`);
      }
    },

    getAll(): ChannelHealth[] {
      return Array.from(providers.values()).map((p) => p.getStatus());
    },

    getByChannel(channel: string): ChannelHealth | null {
      const provider = providers.get(channel);
      return provider?.getStatus() ?? null;
    },

    async heartbeatAll(): Promise<ChannelHealth[]> {
      const results: ChannelHealth[] = [];
      lastCheck = new Date();

      for (const [channel, provider] of providers) {
        try {
          const health = await provider.heartbeat();
          results.push(health);
        } catch (err) {
          log.error(`Heartbeat failed for ${channel}`, {
            error: err instanceof Error ? err.message : String(err),
          });
          results.push({
            channel,
            status: "unhealthy",
            lastHeartbeat: null,
            consecutiveFailures: 1,
            latencyMs: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return results;
    },

    getSummary(): ChannelHealthSummary {
      const all = this.getAll();
      return {
        total: all.length,
        healthy: all.filter((h) => h.status === "healthy").length,
        degraded: all.filter((h) => h.status === "degraded").length,
        unhealthy: all.filter((h) => h.status === "unhealthy").length,
        unknown: all.filter((h) => h.status === "unknown").length,
        lastCheck,
      };
    },
  };
}

/**
 * Create a basic health provider with automatic status tracking.
 */
export function createBasicHealthProvider(params: {
  channel: string;
  checkFn: () => Promise<void>;
  degradedThreshold?: number;
  unhealthyThreshold?: number;
}): ChannelHealthProvider {
  const { channel, checkFn, degradedThreshold = 2, unhealthyThreshold = 5 } = params;

  let lastHeartbeat: Date | null = null;
  let consecutiveFailures = 0;
  let latencyMs: number | null = null;
  let lastError: string | undefined;
  let monitorInterval: ReturnType<typeof setInterval> | null = null;

  const getStatus = (): ChannelHealth => {
    let status: ChannelHealthStatus = "unknown";
    if (lastHeartbeat) {
      if (consecutiveFailures >= unhealthyThreshold) {
        status = "unhealthy";
      } else if (consecutiveFailures >= degradedThreshold) {
        status = "degraded";
      } else {
        status = "healthy";
      }
    }

    return {
      channel,
      status,
      lastHeartbeat,
      consecutiveFailures,
      latencyMs,
      error: lastError,
    };
  };

  const heartbeat = async (): Promise<ChannelHealth> => {
    const start = Date.now();
    try {
      await checkFn();
      latencyMs = Date.now() - start;
      lastHeartbeat = new Date();
      consecutiveFailures = 0;
      lastError = undefined;
    } catch (err) {
      consecutiveFailures++;
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(`Heartbeat failed for ${channel} (failures: ${consecutiveFailures})`, {
        error: lastError,
      });
    }
    return getStatus();
  };

  return {
    channel,
    heartbeat,
    getStatus,
    startMonitoring(intervalMs: number): void {
      if (monitorInterval) {
        return;
      }
      monitorInterval = setInterval(() => void heartbeat(), intervalMs);
      // Allow process to exit even with timer running (Node.js only)
      const timer = monitorInterval as unknown as { unref?: () => void };
      timer.unref?.();
      log.info(`Started health monitoring for ${channel} (interval: ${intervalMs}ms)`);
    },
    stopMonitoring(): void {
      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        log.info(`Stopped health monitoring for ${channel}`);
      }
    },
  };
}

/** Default health check interval (60 seconds) */
export const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;
