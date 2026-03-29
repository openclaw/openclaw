import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export interface MetricEvent {
  timestamp: number;
  eventType: string;
  category: "agent" | "channel" | "tool" | "gateway" | "system";
  agentId?: string;
  channelId?: string;
  sessionId?: string;
  toolName?: string;
  userId?: string;
  properties: Record<string, unknown>;
  duration?: number;
  success?: boolean;
  error?: string;
  tokensUsed?: number;
  cost?: number;
}

export interface MetricAggregation {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  lastUpdated: number;
}

export interface AnalyticsDashboard {
  totalSessions: number;
  activeSessions: number;
  totalMessages: number;
  totalToolsExecuted: number;
  averageResponseTime: number;
  totalCost: number;
  errorRate: number;
  topTools: Array<{ name: string; count: number; avgDuration: number }>;
  topChannels: Array<{ name: string; count: number; avgResponseTime: number }>;
  recentErrors: Array<{ timestamp: number; error: string; context: string }>;
}

export class MetricsCollector {
  private events: MetricEvent[] = [];
  private aggregations: Map<string, MetricAggregation> = new Map();
  private config: OpenClawConfig;
  private log: ReturnType<typeof createSubsystemLogger>;
  private retentionMs: number = 7 * 24 * 60 * 60 * 1000; // 7 days
  private maxEvents: number = 100000;

  constructor(config: OpenClawConfig) {
    this.config = config;
    this.log = createSubsystemLogger("metrics");
    this.startCleanupTimer();
  }

  /**
   * Record a metric event
   */
  recordEvent(event: Omit<MetricEvent, "timestamp">): void {
    const fullEvent: MetricEvent = {
      ...event,
      timestamp: Date.now()
    };

    this.events.push(fullEvent);
    this.updateAggregations(fullEvent);

    // Keep events within retention limit
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  /**
   * Get analytics dashboard
   */
  getDashboard(timeRangeMs?: number): AnalyticsDashboard {
    const cutoff = timeRangeMs ? Date.now() - timeRangeMs : Date.now() - (24 * 60 * 60 * 1000); // Default 24h
    const recentEvents = this.events.filter(event => event.timestamp >= cutoff);

    return {
      totalSessions: this.countUniqueSessions(recentEvents),
      activeSessions: this.countActiveSessions(recentEvents),
      totalMessages: this.countEvents(recentEvents, "message"),
      totalToolsExecuted: this.countEvents(recentEvents, "tool"),
      averageResponseTime: this.calculateAverageResponseTime(recentEvents),
      totalCost: this.calculateTotalCost(recentEvents),
      errorRate: this.calculateErrorRate(recentEvents),
      topTools: this.getTopTools(recentEvents),
      topChannels: this.getTopChannels(recentEvents),
      recentErrors: this.getRecentErrors(recentEvents)
    };
  }

  /**
   * Get metrics for a specific time period
   */
  getMetrics(
    category: string,
    eventType?: string,
    timeRangeMs?: number
  ): MetricAggregation {
    const cutoff = timeRangeMs ? Date.now() - timeRangeMs : Date.now() - (24 * 60 * 60 * 1000);
    const key = this.getAggregationKey(category, eventType);
    
    const aggregation = this.aggregations.get(key);
    if (!aggregation) {
      return { count: 0, sum: 0, min: 0, max: 0, avg: 0, lastUpdated: Date.now() };
    }

    // Filter events by time range and calculate fresh aggregation
    const recentEvents = this.events.filter(event => 
      event.timestamp >= cutoff &&
      event.category === category &&
      (!eventType || event.eventType === eventType)
    );

    return this.calculateAggregation(recentEvents);
  }

  /**
   * Export metrics to external systems
   */
  exportMetrics(format: "json" | "csv" | "prometheus"): string {
    switch (format) {
      case "json":
        return this.exportAsJSON();
      case "csv":
        return this.exportAsCSV();
      case "prometheus":
        return this.exportAsPrometheus();
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Get performance insights
   */
  getPerformanceInsights(): Array<{
    type: string;
    message: string;
    severity: "info" | "warning" | "error";
    recommendation?: string;
  }> {
    const insights: Array<{
      type: string;
      message: string;
      severity: "info" | "warning" | "error";
      recommendation?: string;
    }> = [];

    const dashboard = this.getDashboard();

    // High error rate
    if (dashboard.errorRate > 0.1) {
      insights.push({
        type: "error_rate",
        message: `High error rate detected: ${(dashboard.errorRate * 100).toFixed(2)}%`,
        severity: "error",
        recommendation: "Review recent errors and check system health"
      });
    }

    // Slow response times
    if (dashboard.averageResponseTime > 10000) {
      insights.push({
        type: "response_time",
        message: `Slow average response time: ${dashboard.averageResponseTime}ms`,
        severity: "warning",
        recommendation: "Consider optimizing slow tools or increasing resources"
      });
    }

    // High cost
    if (dashboard.totalCost > 100) {
      insights.push({
        type: "cost",
        message: `High operational cost: $${dashboard.totalCost.toFixed(2)}`,
        severity: "warning",
        recommendation: "Review tool usage and consider cost optimization"
      });
    }

    // Tool-specific issues
    const slowTools = dashboard.topTools.filter(tool => tool.avgDuration > 5000);
    if (slowTools.length > 0) {
      insights.push({
        type: "slow_tools",
        message: `Slow tools detected: ${slowTools.map(t => t.name).join(", ")}`,
        severity: "info",
        recommendation: "Investigate performance bottlenecks in slow tools"
      });
    }

    return insights;
  }

  private updateAggregations(event: MetricEvent): void {
    const keys = [
      this.getAggregationKey(event.category, event.eventType),
      this.getAggregationKey(event.category, event.eventType, event.toolName),
      this.getAggregationKey(event.category, event.eventType, event.channelId),
      this.getAggregationKey(event.category, event.eventType, event.agentId)
    ];

    for (const key of keys) {
      const existing = this.aggregations.get(key) || {
        count: 0,
        sum: 0,
        min: 0,
        max: 0,
        avg: 0,
        lastUpdated: Date.now()
      };

      const value = event.duration || event.tokensUsed || event.cost || 1;
      
      existing.count++;
      existing.sum += value;
      existing.min = existing.count === 1 ? value : Math.min(existing.min, value);
      existing.max = existing.count === 1 ? value : Math.max(existing.max, value);
      existing.avg = existing.sum / existing.count;
      existing.lastUpdated = Date.now();

      this.aggregations.set(key, existing);
    }
  }

  private getAggregationKey(category: string, eventType?: string, resource?: string): string {
    return [category, eventType, resource].filter(Boolean).join(":");
  }

  private calculateAggregation(events: MetricEvent[]): MetricAggregation {
    const values = events.map(event => event.duration || event.tokensUsed || event.cost || 1);
    
    if (values.length === 0) {
      return { count: 0, sum: 0, min: 0, max: 0, avg: 0, lastUpdated: Date.now() };
    }

    return {
      count: values.length,
      sum: values.reduce((sum, val) => sum + val, 0),
      min: Math.min(...values),
      max: Math.max(...values),
      avg: values.reduce((sum, val) => sum + val, 0) / values.length,
      lastUpdated: Date.now()
    };
  }

  private countEvents(events: MetricEvent[], eventType: string): number {
    return events.filter(event => event.eventType === eventType).length;
  }

  private countUniqueSessions(events: MetricEvent[]): number {
    return new Set(events.map(event => event.sessionId).filter(Boolean)).size;
  }

  private countActiveSessions(events: MetricEvent[]): number {
    const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
    return new Set(
      events
        .filter(event => event.eventType === "session_start" && event.timestamp >= fiveMinutesAgo)
        .map(event => event.sessionId)
        .filter(Boolean)
    ).size;
  }

  private calculateAverageResponseTime(events: MetricEvent[]): number {
    const responseEvents = events.filter(event => event.duration && event.eventType === "message");
    if (responseEvents.length === 0) return 0;
    
    const totalDuration = responseEvents.reduce((sum, event) => sum + (event.duration || 0), 0);
    return totalDuration / responseEvents.length;
  }

  private calculateTotalCost(events: MetricEvent[]): number {
    return events.reduce((sum, event) => sum + (event.cost || 0), 0);
  }

  private calculateErrorRate(events: MetricEvent[]): number {
    const totalEvents = events.length;
    const errorEvents = events.filter(event => event.success === false).length;
    return totalEvents > 0 ? errorEvents / totalEvents : 0;
  }

  private getTopTools(events: MetricEvent[]): Array<{ name: string; count: number; avgDuration: number }> {
    const toolEvents = events.filter(event => event.eventType === "tool" && event.toolName);
    const toolStats = new Map<string, { count: number; totalDuration: number }>();

    for (const event of toolEvents) {
      const existing = toolStats.get(event.toolName!) || { count: 0, totalDuration: 0 };
      existing.count++;
      existing.totalDuration += event.duration || 0;
      toolStats.set(event.toolName!, existing);
    }

    return Array.from(toolStats.entries())
      .map(([name, stats]) => ({
        name,
        count: stats.count,
        avgDuration: stats.count > 0 ? stats.totalDuration / stats.count : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private getTopChannels(events: MetricEvent[]): Array<{ name: string; count: number; avgResponseTime: number }> {
    const channelEvents = events.filter(event => event.channelId);
    const channelStats = new Map<string, { count: number; totalDuration: number }>();

    for (const event of channelEvents) {
      const existing = channelStats.get(event.channelId!) || { count: 0, totalDuration: 0 };
      existing.count++;
      existing.totalDuration += event.duration || 0;
      channelStats.set(event.channelId!, existing);
    }

    return Array.from(channelStats.entries())
      .map(([name, stats]) => ({
        name,
        count: stats.count,
        avgResponseTime: stats.count > 0 ? stats.totalDuration / stats.count : 0
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  private getRecentErrors(events: MetricEvent[], limit: number = 50): Array<{ timestamp: number; error: string; context: string }> {
    return events
      .filter(event => event.success === false && event.error)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map(event => ({
        timestamp: event.timestamp,
        error: event.error!,
        context: `${event.category}:${event.eventType}:${event.toolName || event.channelId || event.agentId || "unknown"}`
      }));
  }

  private exportAsJSON(): string {
    const dashboard = this.getDashboard();
    return JSON.stringify(dashboard, null, 2);
  }

  private exportAsCSV(): string {
    const events = this.events.slice(-1000); // Last 1000 events
    const headers = ["timestamp", "eventType", "category", "agentId", "channelId", "sessionId", "toolName", "userId", "duration", "success", "error", "tokensUsed", "cost"];
    
    const rows = [
      headers.join(","),
      ...events.map(event => [
        event.timestamp,
        event.eventType,
        event.category,
        event.agentId || "",
        event.channelId || "",
        event.sessionId || "",
        event.toolName || "",
        event.userId || "",
        event.duration || "",
        event.success || "",
        event.error || "",
        event.tokensUsed || "",
        event.cost || ""
      ].join(","))
    ];

    return rows.join("\n");
  }

  private exportAsPrometheus(): string {
    const dashboard = this.getDashboard();
    const metrics = [
      `openclaw_sessions_total ${dashboard.totalSessions}`,
      `openclaw_sessions_active ${dashboard.activeSessions}`,
      `openclaw_messages_total ${dashboard.totalMessages}`,
      `openclaw_tools_executed_total ${dashboard.totalToolsExecuted}`,
      `openclaw_response_time_avg ${dashboard.averageResponseTime}`,
      `openclaw_cost_total ${dashboard.totalCost}`,
      `openclaw_error_rate ${dashboard.errorRate}`
    ];

    return metrics.join("\n");
  }

  private startCleanupTimer(): void {
    setInterval(() => {
      this.cleanupOldEvents();
    }, 60 * 60 * 1000); // Clean every hour
  }

  private cleanupOldEvents(): void {
    const cutoff = Date.now() - this.retentionMs;
    const beforeCount = this.events.length;
    this.events = this.events.filter(event => event.timestamp >= cutoff);
    
    if (this.events.length < beforeCount) {
      this.log.info(`Cleaned up ${beforeCount - this.events.length} old metric events`);
    }

    // Clean up old aggregations
    for (const [key, aggregation] of this.aggregations.entries()) {
      if (aggregation.lastUpdated < cutoff) {
        this.aggregations.delete(key);
      }
    }
  }
}
