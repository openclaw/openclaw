/**
 * Marketplace trust scoring and abuse prevention.
 *
 * Trust model:
 * - Sellers start at score 50 (neutral)
 * - Successful fast completions boost score toward 100
 * - Failures, timeouts, and anomalies reduce score toward 0
 * - Sellers below threshold (default 20) are excluded from routing
 * - Node version attestation: only route to nodes running compatible versions
 */

export type TrustScore = {
  nodeId: string;
  score: number;
  successCount: number;
  failureCount: number;
  avgResponseMs: number;
  lastUpdatedMs: number;
  flags: TrustFlag[];
};

export type TrustFlag =
  | "version_mismatch"
  | "high_failure_rate"
  | "slow_responses"
  | "token_count_anomaly"
  | "suspended";

const INITIAL_SCORE = 50;
const MIN_ROUTING_SCORE = 20;
const EMA_ALPHA = 0.1;
const SUCCESS_TARGET = 90;
const FAILURE_TARGET = 10;
const FAST_RESPONSE_BONUS = 5;
const FAST_THRESHOLD_MS = 5_000;

export class TrustManager {
  private scores = new Map<string, TrustScore>();

  getScore(nodeId: string): TrustScore {
    let score = this.scores.get(nodeId);
    if (!score) {
      score = {
        nodeId,
        score: INITIAL_SCORE,
        successCount: 0,
        failureCount: 0,
        avgResponseMs: 0,
        lastUpdatedMs: Date.now(),
        flags: [],
      };
      this.scores.set(nodeId, score);
    }
    return score;
  }

  /** Record a successful proxy completion. */
  recordSuccess(
    nodeId: string,
    durationMs: number,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const ts = this.getScore(nodeId);
    ts.successCount++;
    ts.lastUpdatedMs = Date.now();

    // EMA score update: trend toward SUCCESS_TARGET.
    const bonus = durationMs < FAST_THRESHOLD_MS ? FAST_RESPONSE_BONUS : 0;
    ts.score = Math.min(100, ts.score * (1 - EMA_ALPHA) + (SUCCESS_TARGET + bonus) * EMA_ALPHA);

    // Update average response time.
    const totalRequests = ts.successCount + ts.failureCount;
    ts.avgResponseMs =
      totalRequests <= 1
        ? durationMs
        : ts.avgResponseMs * ((totalRequests - 1) / totalRequests) + durationMs / totalRequests;

    // Validate token counts — flag anomalies.
    if (outputTokens > 0 && inputTokens > 0) {
      const ratio = outputTokens / inputTokens;
      const hasAnomaly = ts.flags.includes("token_count_anomaly");
      if (ratio > 50) {
        if (!hasAnomaly) {
          ts.flags.push("token_count_anomaly");
        }
      } else if (hasAnomaly) {
        ts.flags = ts.flags.filter((f) => f !== "token_count_anomaly");
      }
    }

    // Clear slow_responses flag if avg is now acceptable.
    if (ts.avgResponseMs < FAST_THRESHOLD_MS * 3) {
      ts.flags = ts.flags.filter((f) => f !== "slow_responses");
    }

    this.updateFlags(ts);
  }

  /** Record a failed proxy attempt. */
  recordFailure(nodeId: string): void {
    const ts = this.getScore(nodeId);
    ts.failureCount++;
    ts.lastUpdatedMs = Date.now();

    // EMA score update: trend toward FAILURE_TARGET.
    ts.score = Math.max(0, ts.score * (1 - EMA_ALPHA) + FAILURE_TARGET * EMA_ALPHA);

    this.updateFlags(ts);
  }

  /** Check if a node is eligible for marketplace routing. */
  isEligible(nodeId: string): boolean {
    const ts = this.scores.get(nodeId);
    if (!ts) {
      return true;
    } // New nodes are eligible.
    if (ts.flags.includes("suspended")) {
      return false;
    }
    return ts.score >= MIN_ROUTING_SCORE;
  }

  /** Validate that a node's version is compatible for marketplace routing. */
  validateNodeVersion(
    nodeId: string,
    nodeVersion: string | undefined,
    minVersion: string,
  ): boolean {
    if (!nodeVersion) {
      const ts = this.getScore(nodeId);
      if (!ts.flags.includes("version_mismatch")) {
        ts.flags.push("version_mismatch");
      }
      return false;
    }

    const isCompatible = compareVersions(nodeVersion, minVersion) >= 0;
    const ts = this.getScore(nodeId);
    if (!isCompatible) {
      if (!ts.flags.includes("version_mismatch")) {
        ts.flags.push("version_mismatch");
      }
    } else {
      ts.flags = ts.flags.filter((f) => f !== "version_mismatch");
    }
    return isCompatible;
  }

  /** Suspend a node from marketplace routing. */
  suspend(nodeId: string): void {
    const ts = this.getScore(nodeId);
    if (!ts.flags.includes("suspended")) {
      ts.flags.push("suspended");
    }
  }

  /** Unsuspend a node. */
  unsuspend(nodeId: string): void {
    const ts = this.getScore(nodeId);
    ts.flags = ts.flags.filter((f) => f !== "suspended");
  }

  /** Remove all trust data for a disconnected node. */
  removeNode(nodeId: string): void {
    this.scores.delete(nodeId);
  }

  /** List all trust scores (for admin dashboard). */
  listScores(): TrustScore[] {
    return [...this.scores.values()];
  }

  private updateFlags(ts: TrustScore): void {
    const total = ts.successCount + ts.failureCount;
    if (total < 5) {
      return;
    } // Not enough data.

    const failureRate = ts.failureCount / total;
    const hasHighFailure = ts.flags.includes("high_failure_rate");
    if (failureRate > 0.3) {
      if (!hasHighFailure) {
        ts.flags.push("high_failure_rate");
      }
    } else if (hasHighFailure && failureRate < 0.15) {
      ts.flags = ts.flags.filter((f) => f !== "high_failure_rate");
    }

    const hasSlow = ts.flags.includes("slow_responses");
    if (ts.avgResponseMs > FAST_THRESHOLD_MS * 6) {
      if (!hasSlow) {
        ts.flags.push("slow_responses");
      }
    }
  }
}

/** Simple semver comparison: returns -1, 0, or 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) {
      return -1;
    }
    if (na > nb) {
      return 1;
    }
  }
  return 0;
}
