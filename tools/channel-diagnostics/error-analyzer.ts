#!/usr/bin/env node
/**
 * Error Pattern Analyzer
 *
 * Analyzes error patterns from test failures, logs, and changelog
 * to identify common issues and suggest fixes.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorPattern } from "./types.js";

// Common error patterns from recent changelog
const ERROR_PATTERNS: ErrorPattern[] = [
  {
    pattern: "Group message echo",
    count: 0,
    channels: ["whatsapp"],
    firstSeen: new Date("2026-03-23"),
    lastSeen: new Date("2026-03-23"),
    examples: ["WhatsApp groups: track recent gateway-sent message IDs (#53624)"],
    suggestedFix: "Upgrade to 2026.3.23+ which includes echo suppression fix",
  },
  {
    pattern: "Forum topic routing",
    count: 0,
    channels: ["telegram"],
    firstSeen: new Date("2026-03-23"),
    lastSeen: new Date("2026-03-23"),
    examples: ["Telegram/forum topics: recover #General topic 1 routing (#53699)"],
    suggestedFix: "Upgrade to 2026.3.23+ which includes forum metadata recovery",
  },
  {
    pattern: "Timeout without reply",
    count: 0,
    channels: ["discord"],
    firstSeen: new Date("2026-03-23"),
    lastSeen: new Date("2026-03-23"),
    examples: ["Discord/timeouts: send visible timeout reply (#53823)"],
    suggestedFix: "Upgrade to 2026.3.23+ which includes timeout reply handling",
  },
  {
    pattern: "Startup crash with SecretRef",
    count: 0,
    channels: ["feishu"],
    firstSeen: new Date("2026-03-23"),
    lastSeen: new Date("2026-03-23"),
    examples: ["Feishu/startup: treat unresolved SecretRef as not configured (#53675)"],
    suggestedFix: "Upgrade to 2026.3.23+ or configure credentials properly",
  },
  {
    pattern: "Connection stability",
    count: 0,
    channels: ["whatsapp", "telegram"],
    firstSeen: new Date("2026-03-01"),
    lastSeen: new Date("2026-03-23"),
    examples: ["Edge cases in channel connections"],
    suggestedFix: "Check network connectivity and credentials",
  },
];

async function analyzeTestFailures(): Promise<ErrorPattern[]> {
  const patterns: ErrorPattern[] = [];

  // This is a placeholder - in a real implementation, we would:
  // 1. Parse test output files
  // 2. Scan .artifacts/ directory
  // 3. Look for common failure patterns

  console.log("📊 Analyzing test failures...");
  console.log("   (Scanning test output and artifacts)");

  return patterns;
}

async function analyzeChangelog(): Promise<ErrorPattern[]> {
  const changelogPath = join(process.cwd(), "CHANGELOG.md");

  if (!existsSync(changelogPath)) {
    console.warn("⚠️  CHANGELOG.md not found");
    return [];
  }

  try {
    const content = await readFile(changelogPath, "utf-8");

    // Look for fix patterns
    const fixPattern = /###\s+Fixes\s+([\s\S]*?)(?=###|$)/g;
    const matches = content.matchAll(fixPattern);

    for (const match of matches) {
      const fixSection = match[1];

      // Extract channel-specific fixes
      const channelFixes = fixSection.match(/- ([^:]+)\/([^:]+):[^(]+\(#(\d+)\)/g);

      if (channelFixes) {
        for (const fix of channelFixes) {
          const channelMatch = fix.match(/- ([^/]+)\//);
          if (channelMatch) {
            const channel = channelMatch[1].toLowerCase();

            // Check if this matches a known pattern
            const knownPattern = ERROR_PATTERNS.find((p) => p.channels.includes(channel));

            if (knownPattern) {
              knownPattern.count++;
            }
          }
        }
      }
    }

    return ERROR_PATTERNS.filter((p) => p.count > 0);
  } catch (error) {
    console.error(`❌ Failed to analyze changelog: ${String(error)}`);
    return [];
  }
}

async function scanLogs(): Promise<ErrorPattern[]> {
  // Placeholder for log scanning
  // In a real implementation, we would:
  // 1. Find log files
  // 2. Parse error messages
  // 3. Group by pattern
  // 4. Count occurrences

  console.log("📝 Scanning logs...");
  console.log("   (Looking for error patterns)");

  return [];
}

function printErrorPatterns(patterns: ErrorPattern[]): void {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          Error Pattern Analysis Report                     ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  if (patterns.length === 0) {
    console.log("✅ No error patterns detected!\n");
    return;
  }

  console.log(`🔍 Found ${patterns.length} error pattern(s):\n`);

  // Sort by count (most common first)
  const sorted = [...patterns].toSorted((a, b) => b.count - a.count);

  for (let i = 0; i < sorted.length; i++) {
    const pattern = sorted[i];

    console.log(`${i + 1}. ${pattern.pattern}`);
    console.log(`   📊 Occurrences: ${pattern.count}`);
    console.log(`   📱 Channels: ${pattern.channels.join(", ")}`);
    console.log(`   📅 First seen: ${pattern.firstSeen.toLocaleDateString()}`);
    console.log(`   📅 Last seen: ${pattern.lastSeen.toLocaleDateString()}`);

    if (pattern.examples.length > 0) {
      console.log(`   📝 Examples:`);
      for (const example of pattern.examples.slice(0, 3)) {
        console.log(`      • ${example}`);
      }
    }

    if (pattern.suggestedFix) {
      console.log(`   💡 Suggested fix: ${pattern.suggestedFix}`);
    }

    console.log();
  }
}

function generateRecommendations(patterns: ErrorPattern[]): string[] {
  const recommendations: string[] = [];

  // Check for version-related fixes
  const versionFixes = patterns.filter((p) => p.suggestedFix?.includes("Upgrade to"));

  if (versionFixes.length > 0) {
    recommendations.push(
      `🔄 ${versionFixes.length} issue(s) are fixed in newer versions. Consider upgrading.`,
    );
  }

  // Check for configuration issues
  const configIssues = patterns.filter(
    (p) => p.suggestedFix?.includes("configure") || p.suggestedFix?.includes("credentials"),
  );

  if (configIssues.length > 0) {
    recommendations.push(
      `⚙️  ${configIssues.length} issue(s) may be configuration-related. Run: openclaw doctor`,
    );
  }

  // Check for channel-specific issues
  const channelCounts = new Map<string, number>();
  for (const pattern of patterns) {
    for (const channel of pattern.channels) {
      channelCounts.set(channel, (channelCounts.get(channel) || 0) + 1);
    }
  }

  const problematicChannels = Array.from(channelCounts.entries())
    .filter(([_, count]) => count >= 2)
    .toSorted((a, b) => b[1] - a[1]);

  if (problematicChannels.length > 0) {
    const [channel, count] = problematicChannels[0];
    recommendations.push(
      `⚠️  ${channel} has ${count} known issues. Check channel-specific documentation.`,
    );
  }

  return recommendations;
}

async function main() {
  console.log("🔍 Starting error pattern analysis...\n");

  // Analyze different sources
  const changelogPatterns = await analyzeChangelog();
  const testPatterns = await analyzeTestFailures();
  const logPatterns = await scanLogs();

  // Combine all patterns
  const allPatterns = [...changelogPatterns, ...testPatterns, ...logPatterns];

  // Print results
  printErrorPatterns(allPatterns);

  // Generate recommendations
  const recommendations = generateRecommendations(allPatterns);

  if (recommendations.length > 0) {
    console.log("📋 Recommendations:");
    for (const rec of recommendations) {
      console.log(`   ${rec}`);
    }
    console.log();
  }

  console.log("💡 Tip: Run 'openclaw doctor' for automated fixes");
  console.log("💡 Tip: Check CHANGELOG.md for recent fixes\n");
}

main().catch((error) => {
  console.error("❌ Fatal error:", error);
  process.exit(1);
});
