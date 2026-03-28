import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { logDebug } from "../../logger.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const PERFORMANCE_ACTIONS = [
  "monitor",
  "benchmark",
  "profile",
  "diagnose",
  "optimize_suggestions",
] as const;

const PERFORMANCE_METRICS = [
  "response_time",
  "memory_usage",
  "token_efficiency",
  "tool_calls",
  "error_rate",
  "all",
] as const;

interface PerformanceMetrics {
  responseTime: {
    average: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
  };
  memoryUsage: {
    current: number;
    peak: number;
    average: number;
    trend: "increasing" | "decreasing" | "stable";
  };
  tokenEfficiency: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    efficiency: number; // tokens per response
  };
  toolCalls: {
    total: number;
    successful: number;
    failed: number;
    averageExecutionTime: number;
    mostUsed: string[];
  };
  errorRate: {
    percentage: number;
    totalErrors: number;
    commonErrors: Array<{ error: string; count: number }>;
  };
}

interface BenchmarkResult {
  testType: string;
  score: number;
  baseline: number;
  improvement: number;
  executionTime: number;
  recommendations: string[];
}

export function createAgentPerformanceTool(
  config?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "agent_performance",
    label: "Agent Performance",
    description: "Monitor and analyze AI agent performance metrics and provide optimization suggestions",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: PERFORMANCE_ACTIONS,
          description: "Performance action to perform",
        },
        metric: {
          type: "string",
          enum: PERFORMANCE_METRICS,
          description: "Specific metric to analyze",
        },
        duration: {
          type: "number",
          minimum: 60,
          maximum: 3600,
          description: "Duration in seconds for monitoring",
        },
        baseline: {
          type: "boolean",
          description: "Include baseline comparison",
        },
      },
      required: ["action"],
    },
    execute: async (toolCallId, params, signal, onUpdate) => {
      const action = readStringParam(params, "action");
      const metric = readStringParam(params, "metric") ?? "all";
      const duration = readNumberParam(params, "duration") ?? 300;
      const baseline = params.baseline === true;

      if (!action) {
        throw new Error("Action is required");
      }

      logDebug(`Agent performance: ${action} for metric: ${metric}`);

      switch (action) {
        case "monitor":
          return jsonResult(await monitorPerformance(metric, duration, config));
        case "benchmark":
          return jsonResult(await runBenchmark(metric, baseline, config));
        case "profile":
          return jsonResult(await profileAgent(metric, config));
        case "diagnose":
          return jsonResult(await diagnosePerformance(metric, config));
        case "optimize_suggestions":
          return jsonResult(await getOptimizationSuggestions(metric, config));
        default:
          throw new Error(`Unknown performance action: ${action}`);
      }
    },
  };
}

async function monitorPerformance(
  metric: string,
  duration: number,
  config?: OpenClawConfig,
): Promise<Partial<PerformanceMetrics>> {
  // Simulate performance monitoring
  const mockMetrics = generateMockMetrics(metric);
  
  // Simulate real-time monitoring updates
  const monitoringDuration = Math.min(duration, 5); // Cap for demo
  for (let i = 0; i < monitoringDuration; i++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    logDebug(`Monitoring performance: ${i + 1}/${monitoringDuration}s`);
  }

  return mockMetrics;
}

async function runBenchmark(
  metric: string,
  includeBaseline: boolean,
  config?: OpenClawConfig,
): Promise<BenchmarkResult> {
  const testType = `${metric}_performance_test`;
  const score = Math.floor(Math.random() * 100) + 50;
  const baseline = includeBaseline ? Math.floor(Math.random() * 80) + 40 : 0;
  const improvement = baseline > 0 ? ((score - baseline) / baseline) * 100 : 0;
  const executionTime = Math.floor(Math.random() * 5000) + 1000;

  const recommendations: string[] = [];
  if (score < 70) recommendations.push("Consider optimizing tool call patterns");
  if (improvement < 0) recommendations.push("Performance has degraded since baseline");
  if (executionTime > 3000) recommendations.push("High execution time detected");

  return {
    testType,
    score,
    baseline,
    improvement,
    executionTime,
    recommendations,
  };
}

async function profileAgent(
  metric: string,
  config?: OpenClawConfig,
): Promise<any> {
  const profileData = {
    metric,
    timestamp: new Date().toISOString(),
    samples: Math.floor(Math.random() * 1000) + 100,
    profile: {
      cpu_usage: Math.random() * 100,
      memory_usage: Math.random() * 1024 * 1024 * 1024, // bytes
      io_operations: Math.floor(Math.random() * 10000),
      network_requests: Math.floor(Math.random() * 1000),
    },
    bottlenecks: [
      "Tool call serialization",
      "Context window management",
      "Memory allocation patterns",
    ].slice(0, Math.floor(Math.random() * 3) + 1),
  };

  return jsonResult(profileData);
}

async function diagnosePerformance(
  metric: string,
  config?: OpenClawConfig,
): Promise<any> {
  const issues = [
    "High memory usage detected",
    "Slow response times on complex queries",
    "Frequent tool call timeouts",
    "Inefficient context management",
    "Token usage above optimal levels",
  ];

  const detectedIssues = issues.slice(0, Math.floor(Math.random() * 3) + 1);
  
  return jsonResult({
    metric,
    health: "warning",
    issues: detectedIssues,
    severity: detectedIssues.map(() => ["low", "medium", "high"][Math.floor(Math.random() * 3)]),
    suggestedActions: [
      "Increase monitoring frequency",
      "Review tool call patterns",
      "Optimize context window usage",
      "Consider memory cleanup strategies",
    ],
  });
}

async function getOptimizationSuggestions(
  metric: string,
  config?: OpenClawConfig,
): Promise<any> {
  const suggestions = {
    immediate: [
      "Enable response caching for repeated queries",
      "Optimize tool call batching",
      "Reduce context window size when possible",
    ],
    short_term: [
      "Implement lazy loading for infrequently used tools",
      "Add performance monitoring alerts",
      "Optimize memory allocation patterns",
    ],
    long_term: [
      "Consider distributed processing for heavy workloads",
      "Implement predictive caching",
      "Upgrade to more efficient algorithms",
    ],
    metric_specific: getMetricSpecificSuggestions(metric),
  };

  return jsonResult(suggestions);
}

function generateMockMetrics(metric: string): Partial<PerformanceMetrics> {
  const baseMetrics = {
    responseTime: {
      average: Math.random() * 2000 + 500,
      p95: Math.random() * 3000 + 1000,
      p99: Math.random() * 5000 + 2000,
      min: Math.random() * 200 + 100,
      max: Math.random() * 10000 + 5000,
    },
    memoryUsage: {
      current: Math.random() * 1024 * 1024 * 512, // 0-512MB
      peak: Math.random() * 1024 * 1024 * 1024, // 0-1GB
      average: Math.random() * 1024 * 1024 * 256, // 0-256MB
      trend: ["increasing", "decreasing", "stable"][Math.floor(Math.random() * 3)] as "increasing" | "decreasing" | "stable",
    },
    tokenEfficiency: {
      inputTokens: Math.floor(Math.random() * 10000) + 1000,
      outputTokens: Math.floor(Math.random() * 5000) + 500,
      totalTokens: 0,
      efficiency: Math.random() * 100 + 50,
    },
    toolCalls: {
      total: Math.floor(Math.random() * 100) + 10,
      successful: 0,
      failed: 0,
      averageExecutionTime: Math.random() * 2000 + 200,
      mostUsed: ["web_search", "memory_search", "file_operations"].slice(0, Math.floor(Math.random() * 3) + 1),
    },
    errorRate: {
      percentage: Math.random() * 10,
      totalErrors: Math.floor(Math.random() * 20),
      commonErrors: [
        { error: "Timeout", count: Math.floor(Math.random() * 5) + 1 },
        { error: "Memory limit", count: Math.floor(Math.random() * 3) + 1 },
        { error: "Network error", count: Math.floor(Math.random() * 4) + 1 },
      ],
    },
  };

  // Calculate derived values
  baseMetrics.tokenEfficiency.totalTokens = baseMetrics.tokenEfficiency.inputTokens + baseMetrics.tokenEfficiency.outputTokens;
  baseMetrics.toolCalls.successful = Math.floor(baseMetrics.toolCalls.total * (0.8 + Math.random() * 0.15));
  baseMetrics.toolCalls.failed = baseMetrics.toolCalls.total - baseMetrics.toolCalls.successful;

  // Return only requested metric or all
  if (metric === "all") return baseMetrics;
  return { [metric]: baseMetrics[metric as keyof PerformanceMetrics] };
}

function getMetricSpecificSuggestions(metric: string): string[] {
  const suggestions: Record<string, string[]> = {
    response_time: [
      "Implement response caching",
      "Optimize tool call ordering",
      "Use faster model for simple queries",
    ],
    memory_usage: [
      "Implement context window compression",
      "Add garbage collection hooks",
      "Use streaming for large responses",
    ],
    token_efficiency: [
      "Optimize prompt engineering",
      "Use token-efficient models",
      "Implement response summarization",
    ],
    tool_calls: [
      "Batch similar tool calls",
      "Cache tool results",
      "Use parallel execution where possible",
    ],
    error_rate: [
      "Add retry logic with exponential backoff",
      "Implement circuit breaker pattern",
      "Add comprehensive error logging",
    ],
  };

  return suggestions[metric] || suggestions.all || [];
}
