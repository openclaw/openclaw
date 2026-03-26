import { emitStalled, emitRecovered } from "./agent-lifecycle.js";

/**
 * Configuration for agent runtime watchdog.
 */
export interface WatchdogConfig {
  /** Maximum time (ms) before considering agent stalled. Default: 60000ms (1 minute) */
  stalledThresholdMs?: number;
  /** Interval (ms) between watchdog checks. Default: 10000ms (10 seconds) */
  checkIntervalMs?: number;
  /** Whether watchdog is enabled. Default: true */
  enabled?: boolean;
}

/**
 * State for tracking an agent's execution.
 */
interface AgentWatchState {
  runId: string;
  startedAt: number;
  lastActivityAt: number;
  lastActivity?: string;
  isStalled: boolean;
  stalledAt?: number;
  sessionKey?: string;
  agentId?: string;
}

const DEFAULT_STALLED_THRESHOLD_MS = 60_000; // 1 minute
const DEFAULT_CHECK_INTERVAL_MS = 10_000; // 10 seconds

/**
 * Watchdog for monitoring agent runtime health.
 * Detects stuck or stalled agents and emits lifecycle events.
 */
export class AgentWatchdog {
  private agents: Map<string, AgentWatchState> = new Map();
  private config: Required<WatchdogConfig>;
  private intervalId?: ReturnType<typeof setInterval>;
  private isRunning = false;

  constructor(config: WatchdogConfig = {}) {
    this.config = {
      stalledThresholdMs: config.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS,
      checkIntervalMs: config.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
      enabled: config.enabled ?? true,
    };
  }

  /**
   * Start the watchdog monitoring.
   */
  start(): void {
    if (!this.config.enabled || this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.checkAgents();
    }, this.config.checkIntervalMs);
  }

  /**
   * Stop the watchdog monitoring.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.isRunning = false;
  }

  /**
   * Register a new agent run to monitor.
   */
  registerAgent(params: {
    runId: string;
    sessionKey?: string;
    agentId?: string;
    startedAt?: number;
  }): void {
    const now = Date.now();
    this.agents.set(params.runId, {
      runId: params.runId,
      startedAt: params.startedAt ?? now,
      lastActivityAt: now,
      isStalled: false,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    });
  }

  /**
   * Update the last activity timestamp for an agent.
   * Call this when the agent makes progress.
   */
  recordActivity(runId: string, activity?: string): void {
    const state = this.agents.get(runId);
    if (state) {
      state.lastActivityAt = Date.now();
      state.lastActivity = activity;
      // If agent was stalled, emit recovered event
      if (state.isStalled && state.stalledAt) {
        const wasStalledForMs = state.lastActivityAt - state.stalledAt;
        emitRecovered({
          runId: state.runId,
          sessionKey: state.sessionKey,
          agentId: state.agentId,
          startedAt: state.startedAt,
          recoveredAt: state.lastActivityAt,
          wasStalledForMs,
        });
        state.isStalled = false;
        state.stalledAt = undefined;
      }
    }
  }

  /**
   * Unregister an agent run.
   */
  unregisterAgent(runId: string): void {
    this.agents.delete(runId);
  }

  /**
   * Get the current state of an agent.
   */
  getAgentState(runId: string): AgentWatchState | undefined {
    return this.agents.get(runId);
  }

  /**
   * Check all monitored agents for stalls.
   */
  private checkAgents(): void {
    const now = Date.now();
    const threshold = this.config.stalledThresholdMs;

    for (const state of this.agents.values()) {
      const timeSinceLastActivity = now - state.lastActivityAt;

      // Agent is stalled
      if (timeSinceLastActivity >= threshold && !state.isStalled) {
        state.isStalled = true;
        state.stalledAt = now;
        emitStalled({
          runId: state.runId,
          sessionKey: state.sessionKey,
          agentId: state.agentId,
          startedAt: state.startedAt,
          stalledDurationMs: timeSinceLastActivity,
          lastActivity: state.lastActivity,
        });
      }
    }
  }

  /**
   * Get the number of currently monitored agents.
   */
  getMonitoredCount(): number {
    return this.agents.size;
  }

  /**
   * Check if the watchdog is running.
   */
  get running(): boolean {
    return this.isRunning;
  }
}

/**
 * Default global watchdog instance.
 * Can be used throughout the application for consistent monitoring.
 */
let globalWatchdog: AgentWatchdog | undefined;

export function getGlobalWatchdog(config?: WatchdogConfig): AgentWatchdog {
  if (!globalWatchdog) {
    globalWatchdog = new AgentWatchdog(config);
  } else if (config) {
    // Warn if config is provided but singleton already exists - config will be ignored
    console.warn(
      "getGlobalWatchdog: config argument ignored - global watchdog already initialized. " +
      "Call stopGlobalWatchdog() first to reconfigure.",
    );
  }
  return globalWatchdog;
}

export function startGlobalWatchdog(config?: WatchdogConfig): void {
  const watchdog = getGlobalWatchdog(config);
  watchdog.start();
}

export function stopGlobalWatchdog(): void {
  if (globalWatchdog) {
    globalWatchdog.stop();
    globalWatchdog = undefined;
  }
}
