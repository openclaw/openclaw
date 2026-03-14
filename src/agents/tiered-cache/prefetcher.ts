/**
 * Predictive Prefetcher
 *
 * Learns access patterns and predicts which slots to prefetch:
 * - Time-based patterns (time of day, day of week)
 * - Session sequences (what follows what)
 * - Topic clustering
 * - Usage frequency analysis
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { AccessPattern, PrefetcherConfig, PrefetchPrediction } from "./types.js";
import { DEFAULT_PREFETCHER_CONFIG } from "./types.js";

const log = createSubsystemLogger("prefetcher");

// ============================================================================
// Pattern Analysis Types
// ============================================================================

type SessionSequence = {
  fromSession: string;
  toSession: string;
  count: number;
  avgTimeBetweenMs: number;
  lastOccurrence: number;
};

type TimePattern = {
  hourOfDay: number; // 0-23
  dayOfWeek: number; // 0-6
  sessionIds: Set<string>;
  accessCount: number;
};

type SessionStats = {
  id: string;
  totalAccesses: number;
  lastAccessTime: number;
  avgIntervalMs: number;
  accessIntervals: number[]; // Last N intervals
};

// ============================================================================
// Prefetcher Implementation
// ============================================================================

export class Prefetcher {
  private readonly config: PrefetcherConfig;
  private readonly accessHistory: AccessPattern[] = [];
  private readonly sessionSequences = new Map<string, SessionSequence>();
  private readonly timePatterns = new Map<string, TimePattern>();
  private readonly sessionStats = new Map<string, SessionStats>();

  // Learning state
  private lastAccessBySession = new Map<string, number>();
  private recentSessions: string[] = [];

  // Predictions cache
  private predictions: PrefetchPrediction[] = [];
  private lastPredictionTime = 0;

  private closed = false;

  constructor(config: Partial<PrefetcherConfig> = {}) {
    this.config = { ...DEFAULT_PREFETCHER_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    log.info("Initializing prefetcher");
    log.info(`Learning enabled: ${this.config.learningEnabled}`);
    log.info(`History size: ${this.config.historySize}`);
    log.info(`Min confidence: ${this.config.minConfidence}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    log.info("Prefetcher closed");
  }

  // --------------------------------------------------------------------------
  // Recording Accesses
  // --------------------------------------------------------------------------

  recordAccess(pattern: Omit<AccessPattern, "timestamp" | "timeOfDay" | "dayOfWeek">): void {
    if (!this.config.learningEnabled) return;

    const now = Date.now();
    const date = new Date(now);

    const fullPattern: AccessPattern = {
      ...pattern,
      timestamp: now,
      timeOfDay: date.getHours(),
      dayOfWeek: date.getDay(),
    };

    // Add to history
    this.accessHistory.push(fullPattern);

    // Trim history if needed
    if (this.accessHistory.length > this.config.historySize) {
      this.accessHistory.shift();
    }

    // Update session stats
    this.updateSessionStats(pattern.sessionId, pattern.slotId, now);

    // Update sequence patterns
    this.updateSequencePatterns(pattern.sessionId, now);

    // Update time patterns
    this.updateTimePatterns(pattern.sessionId, date);

    // Update recent sessions
    this.updateRecentSessions(pattern.sessionId);

    log.debug(`Recorded access for session ${pattern.sessionId}`);
  }

  private updateSessionStats(sessionId: string, slotId: string, now: number): void {
    const existing = this.sessionStats.get(sessionId);
    const lastAccess = this.lastAccessBySession.get(sessionId);

    if (existing) {
      existing.totalAccesses++;

      if (lastAccess) {
        const interval = now - lastAccess;
        existing.accessIntervals.push(interval);

        // Keep only last 10 intervals
        if (existing.accessIntervals.length > 10) {
          existing.accessIntervals.shift();
        }

        // Calculate average
        existing.avgIntervalMs =
          existing.accessIntervals.reduce((a, b) => a + b, 0) / existing.accessIntervals.length;
      }

      existing.lastAccessTime = now;
    } else {
      this.sessionStats.set(sessionId, {
        id: sessionId,
        totalAccesses: 1,
        lastAccessTime: now,
        avgIntervalMs: 0,
        accessIntervals: [],
      });
    }

    this.lastAccessBySession.set(sessionId, now);
  }

  private updateSequencePatterns(sessionId: string, now: number): void {
    // Look at recent sessions to find patterns
    if (this.recentSessions.length >= 2) {
      const prevSession = this.recentSessions[this.recentSessions.length - 2];
      const key = `${prevSession}:${sessionId}`;

      const existing = this.sessionSequences.get(key);
      const timeBetween = now - (this.lastAccessBySession.get(prevSession) ?? now);

      if (existing) {
        existing.count++;
        existing.avgTimeBetweenMs =
          (existing.avgTimeBetweenMs * (existing.count - 1) + timeBetween) / existing.count;
        existing.lastOccurrence = now;
      } else {
        this.sessionSequences.set(key, {
          fromSession: prevSession,
          toSession: sessionId,
          count: 1,
          avgTimeBetweenMs: timeBetween,
          lastOccurrence: now,
        });
      }
    }
  }

  private updateTimePatterns(sessionId: string, date: Date): void {
    const key = `${date.getHours()}:${date.getDay()}`;

    const existing = this.timePatterns.get(key);
    if (existing) {
      existing.sessionIds.add(sessionId);
      existing.accessCount++;
    } else {
      this.timePatterns.set(key, {
        hourOfDay: date.getHours(),
        dayOfWeek: date.getDay(),
        sessionIds: new Set([sessionId]),
        accessCount: 1,
      });
    }
  }

  private updateRecentSessions(sessionId: string): void {
    // Remove if already present
    const idx = this.recentSessions.indexOf(sessionId);
    if (idx !== -1) {
      this.recentSessions.splice(idx, 1);
    }

    // Add to end
    this.recentSessions.push(sessionId);

    // Keep last 20
    if (this.recentSessions.length > 20) {
      this.recentSessions.shift();
    }
  }

  // --------------------------------------------------------------------------
  // Prediction
  // --------------------------------------------------------------------------

  predict(currentSessionId?: string): PrefetchPrediction[] {
    const now = Date.now();
    const date = new Date(now);

    const predictions: PrefetchPrediction[] = [];

    // 1. Sequence-based prediction
    if (currentSessionId) {
      const sequencePredictions = this.predictFromSequences(currentSessionId, now);
      predictions.push(...sequencePredictions);
    }

    // 2. Time-based prediction
    const timePredictions = this.predictFromTimePatterns(date);
    predictions.push(...timePredictions);

    // 3. Frequency-based prediction
    const frequencyPredictions = this.predictFromFrequency(now);
    predictions.push(...frequencyPredictions);

    // Deduplicate and filter
    const seen = new Set<string>();
    const filtered = predictions.filter((p) => {
      if (seen.has(p.slotId)) return false;
      if (p.confidence < this.config.minConfidence) return false;
      seen.add(p.slotId);
      return true;
    });

    // Sort by confidence
    filtered.sort((a, b) => b.confidence - a.confidence);

    // Limit to max prefetch slots
    this.predictions = filtered.slice(0, this.config.maxPrefetchSlots);
    this.lastPredictionTime = now;

    if (this.predictions.length > 0) {
      log.debug(`Generated ${this.predictions.length} predictions`);
    }

    return this.predictions;
  }

  private predictFromSequences(currentSessionId: string, now: number): PrefetchPrediction[] {
    const predictions: PrefetchPrediction[] = [];

    for (const [key, seq] of this.sessionSequences) {
      if (seq.fromSession !== currentSessionId) continue;
      if (seq.count < 2) continue; // Need at least 2 occurrences

      const confidence = Math.min(0.9, seq.count / 10 + 0.3);
      const predictedTime = now + seq.avgTimeBetweenMs;

      predictions.push({
        slotId: seq.toSession,
        sessionId: seq.toSession,
        confidence,
        predictedAccessTime: predictedTime,
        reason: `sequence:${seq.count}occurrences`,
      });
    }

    return predictions;
  }

  private predictFromTimePatterns(date: Date): PrefetchPrediction[] {
    const predictions: PrefetchPrediction[] = [];
    const currentHour = date.getHours();
    const currentDay = date.getDay();

    // Check current and next hour
    for (let hourOffset = 0; hourOffset <= 1; hourOffset++) {
      const hour = (currentHour + hourOffset) % 24;
      const key = `${hour}:${currentDay}`;
      const pattern = this.timePatterns.get(key);

      if (!pattern) continue;

      const timeWeight = hourOffset === 0 ? 0.8 : 0.5;
      const frequencyWeight = Math.min(pattern.accessCount / 50, 0.3);
      const confidence = timeWeight + frequencyWeight;

      for (const sessionId of pattern.sessionIds) {
        predictions.push({
          slotId: sessionId,
          sessionId,
          confidence,
          predictedAccessTime: Date.now() + hourOffset * 3600000,
          reason: `time:hour${hour}day${currentDay}`,
        });
      }
    }

    return predictions;
  }

  private predictFromFrequency(now: number): PrefetchPrediction[] {
    const predictions: PrefetchPrediction[] = [];

    // Sort sessions by access count
    const sorted = Array.from(this.sessionStats.values())
      .sort((a, b) => b.totalAccesses - a.totalAccesses)
      .slice(0, 5);

    for (const stats of sorted) {
      // Skip if accessed recently
      if (now - stats.lastAccessTime < 300000) continue; // 5 minutes

      const recencyWeight = Math.max(0, 1 - (now - stats.lastAccessTime) / 86400000); // 1 day
      const frequencyWeight = Math.min(stats.totalAccesses / 100, 0.5);
      const confidence = recencyWeight * 0.5 + frequencyWeight;

      predictions.push({
        slotId: stats.id,
        sessionId: stats.id,
        confidence,
        predictedAccessTime: now + stats.avgIntervalMs,
        reason: `frequency:${stats.totalAccesses}accesses`,
      });
    }

    return predictions;
  }

  // --------------------------------------------------------------------------
  // Querying
  // --------------------------------------------------------------------------

  getPredictions(): PrefetchPrediction[] {
    // Regenerate if predictions are stale
    if (Date.now() - this.lastPredictionTime > 60000) {
      return this.predict();
    }
    return this.predictions;
  }

  getTopPrediction(): PrefetchPrediction | null {
    const predictions = this.getPredictions();
    return predictions.length > 0 ? predictions[0] : null;
  }

  shouldPrefetch(slotId: string): boolean {
    const predictions = this.getPredictions();
    return predictions.some((p) => p.slotId === slotId);
  }

  getConfidence(slotId: string): number {
    const predictions = this.getPredictions();
    const pred = predictions.find((p) => p.slotId === slotId);
    return pred?.confidence ?? 0;
  }

  // --------------------------------------------------------------------------
  // Stats & Learning Info
  // --------------------------------------------------------------------------

  getStats(): {
    historySize: number;
    sequencesLearned: number;
    timePatternsLearned: number;
    sessionsTracked: number;
  } {
    return {
      historySize: this.accessHistory.length,
      sequencesLearned: this.sessionSequences.size,
      timePatternsLearned: this.timePatterns.size,
      sessionsTracked: this.sessionStats.size,
    };
  }

  getAccessHistory(): AccessPattern[] {
    return [...this.accessHistory];
  }

  getSequencePatterns(): SessionSequence[] {
    return Array.from(this.sessionSequences.values()).sort((a, b) => b.count - a.count);
  }

  // --------------------------------------------------------------------------
  // Reset Learning
  // --------------------------------------------------------------------------

  reset(): void {
    this.accessHistory.length = 0;
    this.sessionSequences.clear();
    this.timePatterns.clear();
    this.sessionStats.clear();
    this.lastAccessBySession.clear();
    this.recentSessions = [];
    this.predictions = [];

    log.info("Prefetcher learning data reset");
  }
}
