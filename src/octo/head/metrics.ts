// Octopus Orchestrator — Metric instrumentation (M1-24)
//
// Defines a provider-agnostic MetricsProvider interface and an OctoMetrics
// class that records arm and event-log metrics.  The provider is injected
// at construction time so that the head package never imports OpenClaw
// internals (OCTO-DEC-033).
//
// Metric names follow the `openclaw_octo_*` prefix convention defined in
// docs/octopus-orchestrator/OBSERVABILITY.md.

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/** Minimal metric-sink contract injected by the downstream wiring layer. */
export interface MetricsProvider {
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  counter(name: string, increment: number, labels?: Record<string, string>): void;
  histogram(name: string, value: number, labels?: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// No-op provider (tests / disabled path)
// ---------------------------------------------------------------------------

/** Silent provider that discards all values. */
export const noopMetricsProvider: MetricsProvider = {
  gauge(): void {},
  counter(): void {},
  histogram(): void {},
};

// ---------------------------------------------------------------------------
// Metric name constants
// ---------------------------------------------------------------------------

export const METRIC_ARMS_ACTIVE = "openclaw_octo_arms_active" as const;
export const METRIC_ARMS_IDLE = "openclaw_octo_arms_idle" as const;
export const METRIC_ARM_SPAWN_DURATION = "openclaw_octo_arm_spawn_duration_seconds" as const;
export const METRIC_ARM_RESTARTS = "openclaw_octo_arm_restarts_total" as const;
export const METRIC_EVENTS_WRITTEN = "openclaw_octo_events_written_total" as const;
export const METRIC_EVENT_LOG_BYTES = "openclaw_octo_event_log_bytes" as const;

// ---------------------------------------------------------------------------
// OctoMetrics
// ---------------------------------------------------------------------------

/** Records octopus-orchestrator metrics via an injected provider. */
export class OctoMetrics {
  private readonly provider: MetricsProvider;

  constructor(provider: MetricsProvider) {
    this.provider = provider;
  }

  /** Set current count of active arms. */
  recordArmsActive(count: number): void {
    this.provider.gauge(METRIC_ARMS_ACTIVE, count);
  }

  /** Set current count of idle arms. */
  recordArmsIdle(count: number): void {
    this.provider.gauge(METRIC_ARMS_IDLE, count);
  }

  /** Observe arm spawn duration in seconds. */
  recordArmSpawnDuration(seconds: number): void {
    this.provider.histogram(METRIC_ARM_SPAWN_DURATION, seconds);
  }

  /** Increment the arm-restart counter by one. */
  recordArmRestart(): void {
    this.provider.counter(METRIC_ARM_RESTARTS, 1);
  }

  /** Increment the events-written counter by one. */
  recordEventWritten(): void {
    this.provider.counter(METRIC_EVENTS_WRITTEN, 1);
  }

  /** Set the current event-log size in bytes. */
  recordEventLogBytes(bytes: number): void {
    this.provider.gauge(METRIC_EVENT_LOG_BYTES, bytes);
  }
}
