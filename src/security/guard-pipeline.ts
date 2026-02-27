/**
 * IBEL Phase 1 — Guard pipeline runner.
 *
 * Runs guards in priority order (highest first), short-circuits on the first
 * non-allow result. Guard exceptions produce a block result (fail-closed).
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type {
  ExecutionContext,
  OpenClawToolMetadata,
  ToolCall,
  ToolExecutionGuard,
  ValidationResult,
} from "./types.js";

const log = createSubsystemLogger("security/guard-pipeline");

export class GuardPipeline {
  private guards: ToolExecutionGuard[] = [];

  /**
   * Register a guard. Guards are kept sorted by priority descending.
   */
  register(guard: ToolExecutionGuard): void {
    this.unregister(guard.name);
    this.guards.push(guard);
    this.guards.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Remove a guard by name.
   */
  unregister(name: string): void {
    this.guards = this.guards.filter((g) => g.name !== name);
  }

  /**
   * Run all guards in priority order. Short-circuits on first non-allow result.
   * Guard exceptions produce a block result (fail-closed).
   */
  async validate(
    call: ToolCall,
    context: ExecutionContext,
    toolMeta?: OpenClawToolMetadata,
  ): Promise<ValidationResult> {
    for (const guard of this.guards) {
      try {
        const result = await guard.validate(call, context, toolMeta);
        if (result.action !== "allow") {
          log.info(
            `guard="${guard.name}" tool="${call.toolName}" action=${result.action}` +
              ("reason" in result ? ` reason="${result.reason}"` : ""),
          );
          return result;
        }
      } catch (err) {
        log.error(`guard="${guard.name}" tool="${call.toolName}" threw: ${String(err)}`);
        return {
          action: "block",
          reason: `Guard "${guard.name}" failed with an exception (fail-closed)`,
        };
      }
    }
    return { action: "allow" };
  }

  /** Number of registered guards. */
  get size(): number {
    return this.guards.length;
  }

  /** Names of registered guards in execution order. */
  guardNames(): string[] {
    return this.guards.map((g) => g.name);
  }
}

// ── Global Singleton ─────────────────────────────────────────────────────────

let globalPipeline: GuardPipeline | null = null;

/**
 * Get the global guard pipeline singleton.
 * Returns null if no pipeline has been initialized (no guards registered).
 */
export function getGlobalGuardPipeline(): GuardPipeline | null {
  return globalPipeline;
}

/**
 * Initialize and return the global guard pipeline.
 * Creates a new pipeline if one doesn't exist.
 */
export function ensureGlobalGuardPipeline(): GuardPipeline {
  if (!globalPipeline) {
    globalPipeline = new GuardPipeline();
  }
  return globalPipeline;
}

/**
 * Reset the global pipeline. Primarily for testing.
 */
export function resetGlobalGuardPipeline(): void {
  globalPipeline = null;
}
