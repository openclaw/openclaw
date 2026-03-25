#!/usr/bin/env node
/**
 * Channel Health Check Tool
 *
 * Monitors all configured channels and reports their health status.
 * This tool is read-only and safe to run in production.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelStatus, HealthCheckResult, DiagnosticReport } from "./types.js";

// Known channel issues from recent changelog
const KNOWN_ISSUES = {
  whatsapp: ["Group message echo (#53624)", "Connection stability"],
  telegram: ["Forum topic routing (#53699)", "Thread ID handling"],
  discord: ["Timeout handling (#53823)", "Auto-thread creation"],
  feishu: [
    "Startup crashes with unresolved SecretRef (#53675)",
    "Document block ordering (#40524)",
  ],
  slack: ["DM reply overhead", "Interactive reply parity (#53389)"],
};

async function findConfigPath(): Promise<string | null> {
  const possiblePaths = [
    join(process.env.HOME || "~", ".openclaw", "openclaw.json"),
    join(process.cwd(), ".openclaw", "openclaw.json"),
    join(process.cwd(), "openclaw.json"),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

async function loadConfig(): Promise<{ channels?: Record<string, unknown> }> {
  const configPath = await findConfigPath();

  if (!configPath) {
    console.warn("⚠️  No config file found. Checking extensions only.");
    return { channels: {} };
  }

  try {
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`❌ Failed to load config: ${String(error)}`);
    return { channels: {} };
  }
}

async function getAvailableChannels(): Promise<string[]> {
  const extensionsPath = join(process.cwd(), "extensions");

  if (!existsSync(extensionsPath)) {
    return [];
  }

  try {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(extensionsPath, { withFileTypes: true });

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !name.startsWith("."));
  } catch (error) {
    console.error(`❌ Failed to read extensions: ${String(error)}`);
    return [];
  }
}

function checkChannelHealth(
  channelId: string,
  config: unknown,
  availableChannels: string[],
): HealthCheckResult {
  const issues: HealthCheckResult["issues"] = [];
  let status: ChannelStatus = "unknown";

  // Check if channel exists
  const channelExists = availableChannels.includes(channelId);
  if (!channelExists) {
    issues.push({
      severity: "error",
      code: "CHANNEL_NOT_FOUND",
      message: `Channel '${channelId}' not found in extensions/`,
      suggestion: "Check if the channel plugin is installed",
    });
    status = "down";
  } else {
    status = "healthy";
  }

  // Check if channel is configured
  const channelConfig = config.channels?.[channelId];
  if (!channelConfig && channelExists) {
    issues.push({
      severity: "info",
      code: "NOT_CONFIGURED",
      message: `Channel '${channelId}' is available but not configured`,
      suggestion: `Run: openclaw channels add ${channelId}`,
    });
    status = "unknown";
  }

  // Check for known issues
  const knownIssues = KNOWN_ISSUES[channelId as keyof typeof KNOWN_ISSUES];
  if (knownIssues && knownIssues.length > 0) {
    issues.push({
      severity: "warning",
      code: "KNOWN_ISSUES",
      message: `Known issues for ${channelId}`,
      suggestion: `Recent fixes: ${knownIssues.join(", ")}`,
    });
    if (status === "healthy") {
      status = "degraded";
    }
  }

  // Check for required configuration
  if (channelConfig) {
    const requiredFields: Record<string, string[]> = {
      telegram: ["botToken"],
      discord: ["token"],
      slack: ["botToken", "appToken"],
      whatsapp: [], // Uses credentials file
    };

    const required = requiredFields[channelId] || [];
    for (const field of required) {
      if (!channelConfig[field]) {
        issues.push({
          severity: "error",
          code: "MISSING_CONFIG",
          message: `Missing required field: ${field}`,
          suggestion: `Set via: openclaw config set channels.${channelId}.${field} YOUR_VALUE`,
        });
        status = "down";
      }
    }
  }

  return {
    channelId,
    channelName: channelId.charAt(0).toUpperCase() + channelId.slice(1),
    status,
    lastChecked: new Date(),
    issues,
    metrics: {},
  };
}

function generateReport(results: HealthCheckResult[]): DiagnosticReport {
  const summary = {
    totalChannels: results.length,
    healthyChannels: results.filter((r) => r.status === "healthy").length,
    degradedChannels: results.filter((r) => r.status === "degraded").length,
    downChannels: results.filter((r) => r.status === "down").length,
  };

  const recommendations: string[] = [];

  // Generate recommendations
  if (summary.downChannels > 0) {
    recommendations.push(
      `🔴 ${summary.downChannels} channel(s) are down. Check configuration and credentials.`,
    );
  }

  if (summary.degradedChannels > 0) {
    recommendations.push(
      `🟡 ${summary.degradedChannels} channel(s) have known issues. Check recent changelog for fixes.`,
    );
  }

  if (summary.healthyChannels === summary.totalChannels) {
    recommendations.push("✅ All channels appear healthy!");
  }

  return {
    timestamp: new Date(),
    summary,
    channels: results,
    commonIssues: [],
    recommendations,
  };
}

function printReport(report: DiagnosticReport): void {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          OpenClaw Channel Health Check Report             ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  console.log(`📊 Summary:`);
  console.log(`   Total Channels: ${report.summary.totalChannels}`);
  console.log(`   ✅ Healthy: ${report.summary.healthyChannels}`);
  console.log(`   🟡 Degraded: ${report.summary.degradedChannels}`);
  console.log(`   🔴 Down: ${report.summary.downChannels}`);
  console.log();

  // Group by status
  const byStatus = {
    healthy: report.channels.filter((c) => c.status === "healthy"),
    degraded: report.channels.filter((c) => c.status === "degraded"),
    down: report.channels.filter((c) => c.status === "down"),
    unknown: report.channels.filter((c) => c.status === "unknown"),
  };

  for (const [status, channels] of Object.entries(byStatus)) {
    if (channels.length === 0) {
      continue;
    }

    const icon =
      status === "healthy" ? "✅" : status === "degraded" ? "🟡" : status === "down" ? "🔴" : "❓";
    console.log(`${icon} ${status.toUpperCase()} (${channels.length}):`);

    for (const channel of channels) {
      console.log(`   • ${channel.channelName}`);

      if (channel.issues.length > 0) {
        for (const issue of channel.issues) {
          const issueIcon =
            issue.severity === "error" ? "  ❌" : issue.severity === "warning" ? "  ⚠️" : "  ℹ️";
          console.log(`${issueIcon} ${issue.message}`);
          if (issue.suggestion) {
            console.log(`     💡 ${issue.suggestion}`);
          }
        }
      }
    }
    console.log();
  }

  if (report.recommendations.length > 0) {
    console.log("📋 Recommendations:");
    for (const rec of report.recommendations) {
      console.log(`   ${rec}`);
    }
    console.log();
  }

  console.log(`⏰ Report generated at: ${report.timestamp.toLocaleString()}`);
  console.log();
}

async function main() {
  console.log("🔍 Starting channel health check...\n");

  const config = await loadConfig();
  const availableChannels = await getAvailableChannels();

  console.log(`📦 Found ${availableChannels.length} available channel extensions`);

  // Get all channels (configured + available)
  const allChannels = new Set([...Object.keys(config.channels || {}), ...availableChannels]);

  const results: HealthCheckResult[] = [];

  for (const channelId of allChannels) {
    const result = checkChannelHealth(channelId, config, availableChannels);
    results.push(result);
  }

  const report = generateReport(results);
  printReport(report);

  // Exit with appropriate code
  if (report.summary.downChannels > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
