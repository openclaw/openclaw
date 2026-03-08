/**
 * Dataset Module — Training Data Pipeline for Dream Training
 *
 * Collects (state, action) observation pairs from the live agent loop
 * and serializes them to JSONL files for offline LSTM training.
 *
 * The agent runs during the day, collecting observations.
 * At night, the DreamTrainer reads these files and trains the LSTM.
 *
 * Data flow:
 *   Live Agent Loop → observe() → append() → world-model-YYYY-MM-DD.jsonl
 *   Dream Trainer → loadTrajectories() → train LSTM → save weights
 */

import fs from "node:fs";
import path from "node:path";
import type { WorldModelState, WorldModelAction } from "./types.js";

export interface TrajectoryStep {
  timestamp: number;
  sessionId?: string;
  state: WorldModelState;
  action: WorldModelAction;
}

export interface Trajectory {
  sessionId: string;
  steps: TrajectoryStep[];
}

export class ObservationDataset {
  private readonly dataDir: string;
  private buffer: TrajectoryStep[] = [];
  private readonly flushInterval = 50; // Flush every 50 observations

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /** Get today's dataset filename */
  private getFilename(): string {
    const date = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    return path.join(this.dataDir, `world-model-${date}.jsonl`);
  }

  /** Append an observation to the buffer, flush when full */
  append(state: WorldModelState, action: WorldModelAction): void {
    this.buffer.push({
      timestamp: Date.now(),
      sessionId: state.sessionId,
      state,
      action,
    });

    if (this.buffer.length >= this.flushInterval) {
      this.flush();
    }
  }

  /** Flush buffer to disk */
  flush(): void {
    if (this.buffer.length === 0) {
      return;
    }

    const filename = this.getFilename();
    const lines = this.buffer.map((step) => JSON.stringify(step)).join("\n") + "\n";
    fs.appendFileSync(filename, lines, "utf-8");
    this.buffer = [];
  }

  /**
   * Load all observations from a specific date's file.
   * Groups them into trajectories by sessionId for sequential training.
   */
  loadTrajectories(date?: string): Trajectory[] {
    const targetDate = date ?? new Date().toISOString().split("T")[0];
    const filename = path.join(this.dataDir, `world-model-${targetDate}.jsonl`);

    if (!fs.existsSync(filename)) {
      return [];
    }

    const lines = fs
      .readFileSync(filename, "utf-8")
      .split("\n")
      .filter((l: string) => l.trim());
    const steps: TrajectoryStep[] = [];

    for (const line of lines) {
      try {
        steps.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    // Group by sessionId
    const grouped = new Map<string, TrajectoryStep[]>();
    for (const step of steps) {
      const key = step.sessionId ?? "default";
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(step);
    }

    // Sort each trajectory by timestamp
    const trajectories: Trajectory[] = [];
    for (const [sessionId, sessionSteps] of grouped) {
      sessionSteps.sort((a, b) => a.timestamp - b.timestamp);
      trajectories.push({ sessionId, steps: sessionSteps });
    }

    return trajectories;
  }

  /**
   * Load trajectories from the last N days for broader training.
   */
  loadRecentTrajectories(days: number = 7): Trajectory[] {
    const allTrajectories: Trajectory[] = [];
    const now = new Date();

    for (let d = 0; d < days; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      const dateStr = date.toISOString().split("T")[0];
      allTrajectories.push(...this.loadTrajectories(dateStr));
    }

    return allTrajectories;
  }

  /** List available dataset files */
  listFiles(): string[] {
    if (!fs.existsSync(this.dataDir)) {
      return [];
    }
    return fs
      .readdirSync(this.dataDir)
      .filter((f: string) => f.startsWith("world-model-") && f.endsWith(".jsonl"))
      .toSorted();
  }

  /** Get total observation count across all files */
  totalObservations(): number {
    let total = 0;
    for (const file of this.listFiles()) {
      const filepath = path.join(this.dataDir, file);
      const content = fs.readFileSync(filepath, "utf-8");
      total += content.split("\n").filter((l: string) => l.trim()).length;
    }
    return total + this.buffer.length;
  }
}
