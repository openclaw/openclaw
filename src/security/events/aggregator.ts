/**
 * Security event aggregator
 * Aggregates events over time windows for alerting and intrusion detection
 */

import type { SecurityEvent } from "./schema.js";

/**
 * Event count within a time window
 */
interface EventCount {
  count: number;
  firstSeen: number;
  lastSeen: number;
  events: SecurityEvent[];
}

/**
 * Aggregates security events for pattern detection and alerting
 */
export class SecurityEventAggregator {
  // Map of key -> EventCount
  private eventCounts = new Map<string, EventCount>();

  // Cleanup interval
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly cleanupIntervalMs = 60_000; // 1 minute

  constructor() {
    this.startCleanup();
  }

  /**
   * Track a security event
   * Returns true if a threshold is crossed
   */
  trackEvent(params: {
    key: string;
    event: SecurityEvent;
    threshold: number;
    windowMs: number;
  }): boolean {
    const { key, event, threshold, windowMs } = params;
    const now = Date.now();
    const windowStart = now - windowMs;

    let count = this.eventCounts.get(key);

    if (!count) {
      // First event for this key
      count = {
        count: 1,
        firstSeen: now,
        lastSeen: now,
        events: [event],
      };
      this.eventCounts.set(key, count);
      return false;
    }

    // Filter out events outside the time window
    count.events = count.events.filter((e) => new Date(e.timestamp).getTime() > windowStart);

    // Store previous count before adding new event
    const previousCount = count.events.length;

    // Add new event
    count.events.push(event);
    count.count = count.events.length;
    count.lastSeen = now;

    // Update first seen to oldest event in window
    if (count.events.length > 0) {
      count.firstSeen = new Date(count.events[0].timestamp).getTime();
    }

    // Return true only when threshold is FIRST crossed (not on subsequent events)
    return previousCount < threshold && count.count >= threshold;
  }

  /**
   * Get event count for a key within a window
   */
  getCount(params: { key: string; windowMs: number }): number {
    const { key, windowMs } = params;
    const count = this.eventCounts.get(key);

    if (!count) return 0;

    const now = Date.now();
    const windowStart = now - windowMs;

    // Filter events in window
    const eventsInWindow = count.events.filter(
      (e) => new Date(e.timestamp).getTime() > windowStart,
    );

    return eventsInWindow.length;
  }

  /**
   * Get aggregated events for a key
   */
  getEvents(params: { key: string; windowMs?: number }): SecurityEvent[] {
    const { key, windowMs } = params;
    const count = this.eventCounts.get(key);

    if (!count) return [];

    if (!windowMs) {
      return count.events;
    }

    const now = Date.now();
    const windowStart = now - windowMs;

    return count.events.filter((e) => new Date(e.timestamp).getTime() > windowStart);
  }

  /**
   * Clear events for a key
   */
  clear(key: string): void {
    this.eventCounts.delete(key);
  }

  /**
   * Clear all events
   */
  clearAll(): void {
    this.eventCounts.clear();
  }

  /**
   * Get all active keys
   */
  getActiveKeys(): string[] {
    return Array.from(this.eventCounts.keys());
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalKeys: number;
    totalEvents: number;
    eventsByCategory: Record<string, number>;
    eventsBySeverity: Record<string, number>;
  } {
    const stats = {
      totalKeys: this.eventCounts.size,
      totalEvents: 0,
      eventsByCategory: {} as Record<string, number>,
      eventsBySeverity: {} as Record<string, number>,
    };

    for (const count of this.eventCounts.values()) {
      stats.totalEvents += count.events.length;

      for (const event of count.events) {
        // Count by category
        const cat = event.category;
        stats.eventsByCategory[cat] = (stats.eventsByCategory[cat] || 0) + 1;

        // Count by severity
        const sev = event.severity;
        stats.eventsBySeverity[sev] = (stats.eventsBySeverity[sev] || 0) + 1;
      }
    }

    return stats;
  }

  /**
   * Start periodic cleanup of old events
   */
  private startCleanup(): void {
    if (this.cleanupInterval) return;

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);

    // Don't keep process alive for cleanup
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Clean up old event counts (older than 1 hour)
   */
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 60 * 60 * 1000; // 1 hour

    for (const [key, count] of this.eventCounts.entries()) {
      // Remove if no events in last hour
      if (now - count.lastSeen > maxAge) {
        this.eventCounts.delete(key);
      }
    }
  }

  /**
   * Stop cleanup interval (for testing)
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

/**
 * Singleton aggregator instance
 */
export const securityEventAggregator = new SecurityEventAggregator();
