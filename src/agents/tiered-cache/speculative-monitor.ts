/**
 * Speculative Decoding Monitor
 *
 * Monitors and reports speculative decoding statistics from llama.cpp server.
 * Parses log output and tracks acceptance rates, throughput improvements.
 *
 * For Qwen3.5:35B (MoE), uses ngram-mod which:
 * - Is lightweight (~16MB overhead)
 * - Shares hash pool across all slots
 * - Benefits from longer drafts (48-64 tokens)
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SpeculativeConfig, SpeculativeStats, SpecType } from "./types.js";

const log = createSubsystemLogger("speculative");

// ============================================================================
// Log Parser
// ============================================================================

/** Parsed speculative decoding stats from log line */
type ParsedSpecStats = {
  type: SpecType;
  acceptanceRate: number;
  accepted: number;
  generated: number;
  calls?: {
    begin: number;
    generate: number;
    accumulate: number;
  };
  drafts?: {
    generated: number;
    accepted: number;
  };
  tokens?: {
    generated: number;
    accepted: number;
  };
  durations?: {
    begin: number;
    generate: number;
    accumulate: number;
  };
};

/**
 * Parse speculative decoding statistics from llama.cpp log output
 *
 * Example log lines:
 * - "draft acceptance rate = 0.57576 (  171 accepted /   297 generated)"
 * - "statistics ngram_mod: #calls = 810, #gen drafts = 15, #acc drafts = 15, #gen tokens = 960, #acc tokens = 730, dur(b,g,a) = 0.149, 0.347, 0.005 ms"
 * - "statistics ngram_map_k: #calls(b,g,a) = 6 1690 26, #gen drafts = 26, #acc drafts = 26, #gen tokens = 1248, #acc tokens = 968, dur(b,g,a) = 2.234, 1.427, 0.016 ms"
 */
function parseSpecStatsLog(line: string): ParsedSpecStats | null {
  // Parse acceptance rate line
  const acceptMatch = line.match(
    /draft acceptance rate = ([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\)/,
  );
  if (acceptMatch) {
    return {
      type: "none",
      acceptanceRate: parseFloat(acceptMatch[1]),
      accepted: parseInt(acceptMatch[2]),
      generated: parseInt(acceptMatch[3]),
    };
  }

  // Parse ngram-mod stats line
  const ngramModMatch = line.match(
    /statistics ngram_mod:\s*#calls = (\d+),\s*#gen drafts = (\d+),\s*#acc drafts = (\d+),\s*#gen tokens = (\d+),\s*#acc tokens = (\d+),\s*dur\(b,g,a\) = ([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*ms/,
  );
  if (ngramModMatch) {
    return {
      type: "ngram-mod",
      acceptanceRate: 0, // Calculated from tokens
      accepted: 0,
      generated: 0,
      calls: {
        begin: parseInt(ngramModMatch[1]),
        generate: parseInt(ngramModMatch[1]),
        accumulate: parseInt(ngramModMatch[1]),
      },
      drafts: {
        generated: parseInt(ngramModMatch[2]),
        accepted: parseInt(ngramModMatch[3]),
      },
      tokens: {
        generated: parseInt(ngramModMatch[4]),
        accepted: parseInt(ngramModMatch[5]),
      },
      durations: {
        begin: parseFloat(ngramModMatch[6]),
        generate: parseFloat(ngramModMatch[7]),
        accumulate: parseFloat(ngramModMatch[8]),
      },
    };
  }

  // Parse ngram-map stats line (with separate call counts)
  const ngramMapMatch = line.match(
    /statistics (\w+):\s*#calls\(b,g,a\) = (\d+)\s+(\d+)\s+(\d+),\s*#gen drafts = (\d+),\s*#acc drafts = (\d+),\s*#gen tokens = (\d+),\s*#acc tokens = (\d+),\s*dur\(b,g,a\) = ([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*ms/,
  );
  if (ngramMapMatch) {
    return {
      type: ngramMapMatch[1] as SpecType,
      acceptanceRate: 0,
      accepted: 0,
      generated: 0,
      calls: {
        begin: parseInt(ngramMapMatch[2]),
        generate: parseInt(ngramMapMatch[3]),
        accumulate: parseInt(ngramMapMatch[4]),
      },
      drafts: {
        generated: parseInt(ngramMapMatch[5]),
        accepted: parseInt(ngramMapMatch[6]),
      },
      tokens: {
        generated: parseInt(ngramMapMatch[7]),
        accepted: parseInt(ngramMapMatch[8]),
      },
      durations: {
        begin: parseFloat(ngramMapMatch[9]),
        generate: parseFloat(ngramMapMatch[10]),
        accumulate: parseFloat(ngramMapMatch[11]),
      },
    };
  }

  return null;
}

// ============================================================================
// Speculative Monitor
// ============================================================================

export class SpeculativeMonitor {
  private readonly config: SpeculativeConfig;
  private stats: SpeculativeStats;
  private history: Array<{ timestamp: number; stats: SpeculativeStats }> = [];
  private readonly maxHistory = 100;

  constructor(config: SpeculativeConfig) {
    this.config = config;

    this.stats = {
      enabled: config.enabled,
      type: config.type,
      acceptanceRate: 0,
      callsBegin: 0,
      callsGenerate: 0,
      callsAccumulate: 0,
      draftsGenerated: 0,
      draftsAccepted: 0,
      tokensGenerated: 0,
      tokensAccepted: 0,
      durationBeginMs: 0,
      durationGenerateMs: 0,
      durationAccumulateMs: 0,
      lastUpdatedAt: Date.now(),
    };
  }

  // --------------------------------------------------------------------------
  // Log Processing
  // --------------------------------------------------------------------------

  /**
   * Process a log line and update stats if it contains speculative decoding info
   */
  processLogLine(line: string): boolean {
    const parsed = parseSpecStatsLog(line);
    if (!parsed) return false;

    this.updateFromParsed(parsed);
    return true;
  }

  /**
   * Process multiple log lines
   */
  processLogLines(lines: string[]): number {
    let processed = 0;
    for (const line of lines) {
      if (this.processLogLine(line)) {
        processed++;
      }
    }
    return processed;
  }

  private updateFromParsed(parsed: ParsedSpecStats): void {
    // Update type if detected
    if (parsed.type !== "none") {
      this.stats.type = parsed.type;
    }

    // Update acceptance rate
    if (parsed.acceptanceRate > 0) {
      this.stats.acceptanceRate = parsed.acceptanceRate;
    }

    // Update calls
    if (parsed.calls) {
      this.stats.callsBegin += parsed.calls.begin;
      this.stats.callsGenerate += parsed.calls.generate;
      this.stats.callsAccumulate += parsed.calls.accumulate;
    }

    // Update drafts
    if (parsed.drafts) {
      this.stats.draftsGenerated += parsed.drafts.generated;
      this.stats.draftsAccepted += parsed.drafts.accepted;
    }

    // Update tokens
    if (parsed.tokens) {
      this.stats.tokensGenerated += parsed.tokens.generated;
      this.stats.tokensAccepted += parsed.tokens.accepted;

      // Calculate acceptance rate from tokens
      if (this.stats.tokensGenerated > 0) {
        this.stats.acceptanceRate = this.stats.tokensAccepted / this.stats.tokensGenerated;
      }
    }

    // Update durations (average)
    if (parsed.durations) {
      const alpha = 0.1; // EMA smoothing
      this.stats.durationBeginMs =
        this.stats.durationBeginMs * (1 - alpha) + parsed.durations.begin * alpha;
      this.stats.durationGenerateMs =
        this.stats.durationGenerateMs * (1 - alpha) + parsed.durations.generate * alpha;
      this.stats.durationAccumulateMs =
        this.stats.durationAccumulateMs * (1 - alpha) + parsed.durations.accumulate * alpha;
    }

    this.stats.lastUpdatedAt = Date.now();

    // Record history
    this.recordHistory();
  }

  private recordHistory(): void {
    this.history.push({
      timestamp: Date.now(),
      stats: { ...this.stats },
    });

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }
  }

  // --------------------------------------------------------------------------
  // Stats Access
  // --------------------------------------------------------------------------

  getStats(): SpeculativeStats {
    return { ...this.stats };
  }

  /**
   * Get acceptance rate as percentage
   */
  getAcceptanceRatePercent(): number {
    return this.stats.acceptanceRate * 100;
  }

  /**
   * Estimate throughput improvement
   *
   * Speculative decoding improves throughput when acceptance rate is high.
   * Rough estimate: improvement = 1 / (1 - acceptance_rate * draft_length_factor)
   */
  getEstimatedThroughputImprovement(): number {
    if (!this.stats.enabled || this.stats.acceptanceRate === 0) {
      return 1.0;
    }

    // Average draft length
    const avgDraftLength =
      this.stats.draftsGenerated > 0
        ? this.stats.tokensGenerated / this.stats.draftsGenerated
        : this.config.draftMax;

    // Rough improvement estimate
    // Higher acceptance rate + longer drafts = more improvement
    const draftFactor = avgDraftLength / 10; // Normalize by typical batch size
    const improvement = 1 + this.stats.acceptanceRate * draftFactor * 0.5;

    return Math.min(improvement, 3.0); // Cap at 3x
  }

  /**
   * Get stats history for plotting
   */
  getHistory(): Array<{
    timestamp: number;
    acceptanceRate: number;
    throughputImprovement: number;
  }> {
    return this.history.map((h) => ({
      timestamp: h.timestamp,
      acceptanceRate: h.stats.acceptanceRate,
      throughputImprovement:
        (h.stats.acceptanceRate *
          (h.stats.tokensGenerated / Math.max(h.stats.draftsGenerated, 1))) /
        10,
    }));
  }

  // --------------------------------------------------------------------------
  // Reporting
  // --------------------------------------------------------------------------

  /**
   * Get a formatted summary string
   */
  getSummary(): string {
    const lines = [
      "Speculative Decoding Stats",
      "-------------------------",
      `Type: ${this.stats.type}`,
      `Enabled: ${this.stats.enabled}`,
      "",
      `Acceptance Rate: ${(this.stats.acceptanceRate * 100).toFixed(1)}%`,
      `Tokens: ${this.stats.tokensAccepted} accepted / ${this.stats.tokensGenerated} generated`,
      `Drafts: ${this.stats.draftsAccepted} accepted / ${this.stats.draftsGenerated} generated`,
      "",
      `Calls: ${this.stats.callsBegin} begin, ${this.stats.callsGenerate} gen, ${this.stats.callsAccumulate} acc`,
      `Avg Duration: ${this.stats.durationBeginMs.toFixed(2)}ms begin, ${this.stats.durationGenerateMs.toFixed(2)}ms gen`,
      "",
      `Est. Throughput Improvement: ${this.getEstimatedThroughputImprovement().toFixed(2)}x`,
    ];

    return lines.join("\n");
  }

  /**
   * Log current stats
   */
  logStats(): void {
    if (this.stats.tokensGenerated > 0) {
      log.info(
        `Speculative: ${(this.stats.acceptanceRate * 100).toFixed(1)}% acceptance, ` +
          `${this.stats.tokensAccepted}/${this.stats.tokensGenerated} tokens, ` +
          `~${this.getEstimatedThroughputImprovement().toFixed(2)}x speedup`,
      );
    }
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createSpeculativeMonitor(config: SpeculativeConfig): SpeculativeMonitor {
  return new SpeculativeMonitor(config);
}
