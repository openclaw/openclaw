/**
 * High-level initialization for the policy feedback subsystem.
 *
 * Called once during gateway startup. Creates the engine, registers hooks,
 * schedules periodic aggregate recomputation and log retention pruning,
 * and returns a handle for shutdown. If the mode is "off", returns a no-op
 * handle without creating an engine or registering hooks.
 *
 * All errors are caught internally — this function never throws.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { createPolicyFeedbackEngine, type PolicyFeedbackEngineImpl } from "./engine.js";
import { clearPolicyFeedbackEngine, setPolicyFeedbackEngine } from "./gateway-bridge.js";
import { registerPolicyFeedbackHooks } from "./hooks.js";
import { pruneOldRecords } from "./persistence.js";
import type { PolicyFeedbackEngine, PolicyMode } from "./types.js";

const log = createSubsystemLogger("policy-feedback:init");

export type PolicyFeedbackHandle = {
  engine: PolicyFeedbackEngine | null;
  mode: PolicyMode;
  shutdown: () => void;
};

/**
 * Start a periodic timer that recomputes aggregates and prunes old logs.
 * Returns a cleanup function to clear the timer.
 */
function startMaintenanceTimer(
  engine: PolicyFeedbackEngineImpl,
  intervalMs: number,
  retentionDays: number,
  home: string,
  agentId: string,
): () => void {
  const timer = setInterval(() => {
    // Recompute aggregates from per-agent log history (matches where actions are stored)
    engine.recomputeAggregates(agentId).catch(() => {});

    // Prune records older than retention period (use the same home as the engine)
    if (retentionDays > 0) {
      pruneOldRecords(retentionDays, { home }).catch((err: unknown) => {
        log.warn("Log retention pruning failed", { error: String(err) });
      });
    }
  }, intervalMs);

  // Prevent the timer from keeping the process alive
  timer.unref();

  return () => clearInterval(timer);
}

/**
 * Initialize the policy feedback subsystem.
 *
 * @param options.agentId - Default agent ID for logging actions
 * @param options.mode - Optional mode override (defaults to config/env)
 * @returns A handle with the engine (or null if off) and a shutdown function
 */
export async function initializePolicyFeedback(options: {
  agentId: string;
  mode?: PolicyMode;
}): Promise<PolicyFeedbackHandle> {
  try {
    const engine = await createPolicyFeedbackEngine({
      config: options.mode ? { mode: options.mode } : undefined,
      agentId: options.agentId,
    });

    // Eagerly initialize all components in dependency order
    engine.start();

    const mode = engine.getMode();

    if (mode === "off") {
      setPolicyFeedbackEngine(null, "off");
      return { engine: null, mode: "off", shutdown: () => {} };
    }

    // Make the engine available to gateway subsystems via the bridge singleton
    setPolicyFeedbackEngine(engine, mode);

    const unsubHooks = registerPolicyFeedbackHooks({
      engine,
      getMode: () => engine.getMode(),
      agentId: options.agentId,
    });

    // Schedule periodic aggregate recomputation and log retention pruning
    // using the resolved config values (not hardcoded defaults).
    const resolvedConfig = engine.getResolvedConfig();
    const stopMaintenance = startMaintenanceTimer(
      engine,
      resolvedConfig.aggregateIntervalMs,
      resolvedConfig.logRetentionDays,
      engine.getHome(),
      options.agentId,
    );

    return {
      engine,
      mode,
      shutdown: () => {
        clearPolicyFeedbackEngine();
        unsubHooks();
        stopMaintenance();
      },
    };
  } catch {
    // Fail silently — policy feedback is non-critical
    return { engine: null, mode: "off", shutdown: () => {} };
  }
}
