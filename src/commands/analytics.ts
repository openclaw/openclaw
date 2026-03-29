import { getMetricsCollector } from "../analytics/index.js";
import * as fs from "node:fs";

export type AnalyticsOptions = {
  format?: "json" | "dashboard" | "insights";
  timeRange?: number;
  export?: string;
};

/**
 * Display analytics dashboard and metrics
 */
export async function analyticsCommand(options: AnalyticsOptions = {}): Promise<void> {
  const metrics = getMetricsCollector();
  const format = options.format ?? "dashboard";
  const timeRangeMs = options.timeRange ?? (24 * 60 * 60 * 1000); // Default 24h

  switch (format) {
    case "dashboard":
      const dashboard = metrics.getDashboard(timeRangeMs);
      console.log("\n📊 OpenClaw Analytics Dashboard");
      console.log("=" .repeat(40));
      console.log(`Time range: Last ${timeRangeMs / (60 * 60 * 1000)} hours\n`);
      
      console.log("🤖 Agent Activity:");
      console.log(`  Total sessions: ${dashboard.totalSessions}`);
      console.log(`  Active sessions: ${dashboard.activeSessions}`);
      console.log(`  Total messages: ${dashboard.totalMessages}`);
      console.log(`  Error rate: ${(dashboard.errorRate * 100).toFixed(2)}%\n`);
      
      console.log("🔧 Tool Usage:");
      console.log(`  Total executions: ${dashboard.totalToolsExecuted}`);
      console.log(`  Avg response time: ${dashboard.averageResponseTime.toFixed(0)}ms`);
      if (dashboard.topTools.length > 0) {
        console.log("\n  Top tools:");
        dashboard.topTools.slice(0, 5).forEach((tool, i) => {
          console.log(`    ${i + 1}. ${tool.name}: ${tool.count} uses (${tool.avgDuration.toFixed(0)}ms avg)`);
        });
      }
      console.log("");
      
      console.log("📡 Channel Activity:");
      if (dashboard.topChannels.length > 0) {
        dashboard.topChannels.slice(0, 5).forEach((channel, i) => {
          console.log(`    ${i + 1}. ${channel.name}: ${channel.count} messages (${channel.avgResponseTime.toFixed(0)}ms avg)`);
        });
      }
      console.log("");
      
      console.log("💰 Cost Analysis:");
      console.log(`  Total cost: $${dashboard.totalCost.toFixed(4)}`);
      console.log("");
      
      if (dashboard.recentErrors.length > 0) {
        console.log("🚨 Recent Errors:");
        dashboard.recentErrors.slice(0, 3).forEach((error, i) => {
          const time = new Date(error.timestamp).toLocaleTimeString();
          console.log(`    ${i + 1}. [${time}] ${error.error}`);
        });
        console.log("");
      }
      break;

    case "insights":
      const insights = metrics.getPerformanceInsights();
      console.log("\n🔍 Performance Insights");
      console.log("=" .repeat(30));
      
      if (insights.length === 0) {
        console.log("✅ No performance issues detected!");
      } else {
        insights.forEach((insight, i) => {
          const icon = insight.severity === "error" ? "🚨" : 
                       insight.severity === "warning" ? "⚠️" : "ℹ️";
          console.log(`\n${icon} ${insight.message}`);
          if (insight.recommendation) {
            console.log(`💡 ${insight.recommendation}`);
          }
        });
      }
      console.log("");
      break;

    case "json":
      const data = {
        dashboard: metrics.getDashboard(timeRangeMs),
        insights: metrics.getPerformanceInsights(),
        timeRangeMs,
        generatedAt: new Date().toISOString()
      };
      
      if (options.export) {
        fs.writeFileSync(options.export, JSON.stringify(data, null, 2));
        console.log(`Analytics exported to: ${options.export}`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      break;
  }
}

/**
 * Export metrics in various formats
 */
export async function exportMetricsCommand(format: "json" | "csv" | "prometheus", outputFile?: string): Promise<void> {
  const metrics = getMetricsCollector();
  const data = metrics.exportMetrics(format);
  
  if (outputFile) {
    require("fs").writeFileSync(outputFile, data);
    console.log(`Metrics exported to: ${outputFile}`);
  } else {
    console.log(data);
  }
}
