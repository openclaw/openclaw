import { loadConfig } from "../config/config.js";
import { MetricsCollector } from "./metrics-collector.js";

let globalMetricsCollector: MetricsCollector | null = null;

/**
 * Get the global metrics collector instance
 */
export function getMetricsCollector(): MetricsCollector {
  if (!globalMetricsCollector) {
    const config = loadConfig();
    globalMetricsCollector = new MetricsCollector(config);
  }
  return globalMetricsCollector;
}

/**
 * Reset the global metrics collector (useful for testing)
 */
export function resetMetricsCollector(): void {
  globalMetricsCollector = null;
}

/**
 * Record an agent execution metric
 */
export function recordAgentExecution(params: {
  agentId: string;
  sessionId: string;
  duration: number;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  cost?: number;
  toolCount?: number;
}): void {
  const metrics = getMetricsCollector();
  metrics.recordEvent({
    eventType: "agent_execution",
    category: "agent",
    agentId: params.agentId,
    sessionId: params.sessionId,
    duration: params.duration,
    success: params.success,
    error: params.error,
    tokensUsed: params.tokensUsed,
    cost: params.cost,
    properties: {
      toolCount: params.toolCount || 0
    }
  });
}

/**
 * Record a tool execution metric
 */
export function recordToolExecution(params: {
  toolName: string;
  sessionId: string;
  agentId?: string;
  duration: number;
  success: boolean;
  error?: string;
  tokensUsed?: number;
  cost?: number;
}): void {
  const metrics = getMetricsCollector();
  metrics.recordEvent({
    eventType: "tool_execution",
    category: "tool",
    toolName: params.toolName,
    sessionId: params.sessionId,
    agentId: params.agentId,
    duration: params.duration,
    success: params.success,
    error: params.error,
    tokensUsed: params.tokensUsed,
    cost: params.cost,
    properties: {}
  });
}

/**
 * Record a channel activity metric
 */
export function recordChannelActivity(params: {
  channelId: string;
  eventType: "message" | "error" | "connection";
  sessionId?: string;
  success?: boolean;
  error?: string;
  duration?: number;
}): void {
  const metrics = getMetricsCollector();
  metrics.recordEvent({
    eventType: params.eventType,
    category: "channel",
    channelId: params.channelId,
    sessionId: params.sessionId,
    success: params.success,
    error: params.error,
    duration: params.duration,
    properties: {}
  });
}

/**
 * Record a system metric
 */
export function recordSystemMetric(params: {
  eventType: string;
  success?: boolean;
  error?: string;
  duration?: number;
  properties?: Record<string, unknown>;
}): void {
  const metrics = getMetricsCollector();
  metrics.recordEvent({
    eventType: params.eventType,
    category: "system",
    success: params.success,
    error: params.error,
    duration: params.duration,
    properties: params.properties || {}
  });
}
