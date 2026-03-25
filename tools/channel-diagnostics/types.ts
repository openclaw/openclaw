/**
 * Common types for channel diagnostics toolkit
 */

export type ChannelStatus = "healthy" | "degraded" | "down" | "unknown";

export type HealthCheckResult = {
  channelId: string;
  channelName: string;
  status: ChannelStatus;
  lastChecked: Date;
  issues: ChannelIssue[];
  metrics: ChannelMetrics;
};

export type ChannelIssue = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  suggestion?: string;
  relatedFiles?: string[];
};

export type ChannelMetrics = {
  responseTime?: number;
  errorRate?: number;
  lastSuccessfulMessage?: Date;
  connectionUptime?: number;
};

export type ErrorPattern = {
  pattern: string;
  count: number;
  channels: string[];
  firstSeen: Date;
  lastSeen: Date;
  examples: string[];
  suggestedFix?: string;
};

export type DiagnosticReport = {
  timestamp: Date;
  summary: {
    totalChannels: number;
    healthyChannels: number;
    degradedChannels: number;
    downChannels: number;
  };
  channels: HealthCheckResult[];
  commonIssues: ErrorPattern[];
  recommendations: string[];
};
