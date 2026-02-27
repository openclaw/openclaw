/**
 * Security Subsystem Coordinator (AR-1)
 *
 * Single entry-point to initialize and teardown the five security singletons
 * in dependency order, eliminating startup-order races and providing a clean
 * destroy path.
 *
 * Initialization order:
 *   1. SecurityEventsManager  — event bus; others may emit events during init
 *   2. SessionRiskMonitor     — stateful; independent of tool monitor
 *   3. ToolMonitor            — stateful; independent of session monitor
 *   4. AnomalyDetector        — stateless baseline engine
 *   5. MonitorRunner          — polling loop; depends on all of the above
 *
 * Teardown order is reversed: runner stops first, event bus last.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { AnomalyDetectionConfig } from "./anomaly-detection.js";
import type { MonitorRunnerConfig } from "./monitor-runner.js";
import type { SecurityEventsConfig, AlertingConfig } from "./security-events.js";
import type { SessionMonitoringConfig } from "./session-monitoring.js";
import type { ToolMonitoringConfig } from "./tool-monitoring.js";

const log = createSubsystemLogger("security/coordinator");

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

export interface SecurityCoordinatorConfig {
  events?: SecurityEventsConfig;
  alerting?: AlertingConfig;
  runner?: MonitorRunnerConfig;
  session?: SessionMonitoringConfig;
  tool?: ToolMonitoringConfig;
  anomaly?: AnomalyDetectionConfig;
}

// -----------------------------------------------------------------------------
// Coordinator
// -----------------------------------------------------------------------------

export class SecuritySubsystemCoordinator {
  private started = false;
  private readonly config: SecurityCoordinatorConfig;

  constructor(config: SecurityCoordinatorConfig = {}) {
    this.config = config;
  }

  /**
   * Initialize all security singletons in dependency order.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async start(): Promise<void> {
    if (this.started) {
      log.warn("SecuritySubsystemCoordinator.start() called while already running — no-op");
      return;
    }
    this.started = true;
    log.info("starting security subsystems");

    // 1. Events bus first — others may emit events during their own init.
    const { getSecurityEventsManager } = await import("./security-events.js");
    const manager = getSecurityEventsManager(this.config.events, this.config.alerting);
    await manager.init();

    // 2. Session + tool monitors + anomaly detector are mutually independent.
    const [{ getSessionRiskMonitor }, { getToolMonitor }, { getAnomalyDetector }] =
      await Promise.all([
        import("./session-monitoring.js"),
        import("./tool-monitoring.js"),
        import("./anomaly-detection.js"),
      ]);
    getSessionRiskMonitor(this.config.session);
    getToolMonitor(this.config.tool);
    getAnomalyDetector(this.config.anomaly);

    // 3. Monitor runner last — it polls all of the above.
    const { getMonitorRunner } = await import("./monitor-runner.js");
    getMonitorRunner(this.config.runner);

    log.info("security subsystems ready");
  }

  /**
   * Stop all running subsystems and reset singletons.
   * Runner is stopped first; event bus is reset last.
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    log.info("stopping security subsystems");

    const [
      { resetMonitorRunner },
      { resetSessionRiskMonitor },
      { resetToolMonitor },
      { resetAnomalyDetectors },
      { resetSecurityEventsManager },
    ] = await Promise.all([
      import("./monitor-runner.js"),
      import("./session-monitoring.js"),
      import("./tool-monitoring.js"),
      import("./anomaly-detection.js"),
      import("./security-events.js"),
    ]);

    resetMonitorRunner(); // stop polling loop first
    resetSessionRiskMonitor();
    resetToolMonitor();
    resetAnomalyDetectors();
    resetSecurityEventsManager(); // event bus last

    log.info("security subsystems stopped");
  }

  isStarted(): boolean {
    return this.started;
  }
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

let defaultCoordinator: SecuritySubsystemCoordinator | undefined;

/**
 * Get or create the default SecuritySubsystemCoordinator.
 * Config is only applied on first call; subsequent calls return the same instance.
 */
export function getSecurityCoordinator(
  config?: SecurityCoordinatorConfig,
): SecuritySubsystemCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new SecuritySubsystemCoordinator(config);
  } else if (config !== undefined) {
    log.warn(
      "getSecurityCoordinator() called again with config — singleton already initialized; config ignored",
    );
  }
  return defaultCoordinator;
}

/**
 * Reset the coordinator singleton (for testing).
 * Does NOT stop running subsystems — call stop() first if needed.
 */
export function resetSecurityCoordinator(): void {
  defaultCoordinator = undefined;
}
