// Octopus Orchestrator -- `openclaw octo arm restart` CLI command (M1-21)
//
// Terminates the current tmux session for an arm, then respawns with the
// same ArmSpec, preserving arm_id and incrementing restart_count. The FSM
// path is: current_state -> failed -> starting (via two applyArmTransition
// calls and CAS updates). The arm row is never deleted or duplicated.
//
// Architecture:
//   restartArm       -- orchestrates kill + re-spawn + CAS updates
//   runArmRestart    -- CLI entry point, returns exit code
//
// Boundary discipline (OCTO-DEC-033):
//   Only imports from `node:*` builtins and relative paths inside `src/octo/`.

import { applyArmTransition, type ArmState } from "../head/arm-fsm.ts";
import type { EventLogService } from "../head/event-log.ts";
import { ConflictError, type ArmRecord, type RegistryService } from "../head/registry.ts";
import type { TmuxManager } from "../node-agent/tmux-manager.ts";
import type { SessionRef } from "../wire/methods.ts";
import type { ArmSpec } from "../wire/schema.ts";

// ──────────────────────────────────────────────────────────────────────────
// Session-name convention (shared with gateway-handlers.ts)
// ──────────────────────────────────────────────────────────────────────────

const SESSION_NAME_PREFIX = "octo-arm-";

function sessionNameForArm(arm_id: string): string {
  return `${SESSION_NAME_PREFIX}${arm_id}`;
}

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export interface ArmRestartDeps {
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager: TmuxManager;
  nodeId: string;
  now?: () => number;
}

export interface ArmRestartResult {
  arm_id: string;
  restart_count: number;
  session_ref: SessionRef;
  previous_state: string;
}

export type ArmRestartErrorCode = "not_found" | "invalid_state" | "tmux_failed" | "conflict";

export class ArmRestartError extends Error {
  constructor(
    public readonly code: ArmRestartErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ArmRestartError";
  }
}

// ──────────────────────────────────────────────────────────────────────────
// States from which restart is allowed
// ──────────────────────────────────────────────────────────────────────────

// Restart requires a two-hop FSM path: current -> failed -> starting.
// "failed" and "quarantined" can reach "starting" directly, but we still
// go through the failed intermediate for consistency. The states listed
// here are those from which a transition to "failed" is valid (per
// arm-fsm.ts ARM_TRANSITIONS), PLUS "failed" itself (no-op first hop).
const RESTARTABLE_STATES: ReadonlySet<string> = new Set<string>([
  "active",
  "idle",
  "blocked",
  "failed",
  "quarantined",
  "starting",
]);

// ──────────────────────────────────────────────────────────────────────────
// Core restart logic
// ──────────────────────────────────────────────────────────────────────────

/**
 * Restart an arm: kill the current tmux session, drive the FSM through
 * failed -> starting, create a new tmux session, bump restart_count,
 * and persist the new session_ref. Preserves arm_id.
 */
export async function restartArm(deps: ArmRestartDeps, arm_id: string): Promise<ArmRestartResult> {
  const now = deps.now ?? (() => Date.now());
  const { registry, eventLog, tmuxManager, nodeId } = deps;

  // 1. Look up the arm.
  const arm = registry.getArm(arm_id);
  if (arm === null) {
    throw new ArmRestartError("not_found", `octo arm restart: arm not found: ${arm_id}`, {
      arm_id,
    });
  }

  // 2. Guard: only restartable states.
  if (!RESTARTABLE_STATES.has(arm.state)) {
    throw new ArmRestartError(
      "invalid_state",
      `octo arm restart: arm ${arm_id} is in state "${arm.state}"; ` +
        `restart is only allowed from: ${[...RESTARTABLE_STATES].join(", ")}`,
      { arm_id, current_state: arm.state },
    );
  }

  const previousState = arm.state;
  const sessionName = sessionNameForArm(arm_id);

  // 3. Kill the existing tmux session (idempotent -- false means already gone).
  try {
    await tmuxManager.killSession(sessionName);
  } catch (err) {
    throw new ArmRestartError(
      "tmux_failed",
      `octo arm restart: tmux killSession failed for ${sessionName}: ${describeError(err)}`,
      { arm_id, sessionName },
    );
  }

  // 4. FSM transition: current -> failed (unless already failed).
  let currentArm: ArmRecord = arm;
  if (arm.state !== "failed") {
    const failedTs = now();
    const failedLike = applyArmTransition(
      { state: currentArm.state, updated_at: currentArm.updated_at },
      "failed" satisfies ArmState,
      { now: failedTs, arm_id },
    );
    try {
      currentArm = registry.casUpdateArm(arm_id, currentArm.version, {
        state: failedLike.state,
        updated_at: failedLike.updated_at,
        health_status: "failed",
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        throw new ArmRestartError(
          "conflict",
          `octo arm restart: concurrent update on arm ${arm_id}: ${err.message}`,
          { arm_id, expected_version: currentArm.version },
        );
      }
      throw err;
    }
  }

  // 5. FSM transition: failed -> starting.
  const startingTs = now();
  const startingLike = applyArmTransition(
    { state: currentArm.state, updated_at: currentArm.updated_at },
    "starting" satisfies ArmState,
    { now: startingTs, arm_id },
  );
  const newRestartCount = currentArm.restart_count + 1;
  try {
    currentArm = registry.casUpdateArm(arm_id, currentArm.version, {
      state: startingLike.state,
      updated_at: startingLike.updated_at,
      health_status: "starting",
      restart_count: newRestartCount,
    });
  } catch (err) {
    if (err instanceof ConflictError) {
      throw new ArmRestartError(
        "conflict",
        `octo arm restart: concurrent update on arm ${arm_id}: ${err.message}`,
        { arm_id, expected_version: currentArm.version },
      );
    }
    throw err;
  }

  // 6. Emit arm.starting event (restart variant, signalled by payload).
  await eventLog.append({
    schema_version: 1,
    entity_type: "arm",
    entity_id: arm_id,
    event_type: "arm.starting",
    ts: new Date(startingTs).toISOString(),
    actor: `node-agent:${nodeId}`,
    payload: {
      restart: true,
      previous_state: previousState,
      restart_count: newRestartCount,
    },
  });

  // 7. Create a new tmux session with the same ArmSpec.
  const spec: ArmSpec = currentArm.spec;
  const runtimeOptions = spec.runtime_options as {
    command: string;
    args?: readonly string[];
  };
  const baseCommand = runtimeOptions.command;
  const extraArgs = runtimeOptions.args ?? [];
  const cmd = extraArgs.length > 0 ? `${baseCommand} ${extraArgs.join(" ")}` : baseCommand;

  try {
    await tmuxManager.createSession(sessionName, cmd, spec.cwd);
  } catch (err) {
    // Drive to failed state on tmux failure.
    const failedTs2 = now();
    const failedLike2 = applyArmTransition(
      { state: currentArm.state, updated_at: currentArm.updated_at },
      "failed" satisfies ArmState,
      { now: failedTs2, arm_id },
    );
    try {
      registry.casUpdateArm(arm_id, currentArm.version, {
        state: failedLike2.state,
        updated_at: failedLike2.updated_at,
        health_status: "failed",
      });
    } catch {
      // Best-effort.
    }
    throw new ArmRestartError(
      "tmux_failed",
      `octo arm restart: tmux createSession failed for ${sessionName}: ${describeError(err)}`,
      { arm_id, sessionName },
    );
  }

  // 8. Persist the new session_ref.
  const session_ref: SessionRef = {
    tmux_session_name: sessionName,
    cwd: spec.cwd,
  };
  registry.casUpdateArm(arm_id, currentArm.version, {
    session_ref: session_ref as unknown as Record<string, unknown>,
    updated_at: now(),
  });

  return {
    arm_id,
    restart_count: newRestartCount,
    session_ref,
    previous_state: previousState,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// CLI entry point
// ──────────────────────────────────────────────────────────────────────────

/**
 * Entry point called by the CLI dispatcher. Returns exit code
 * (0 = success, 1 = error).
 */
export async function runArmRestart(
  deps: ArmRestartDeps,
  arm_id: string,
  out: { write: (s: string) => void } = process.stdout,
): Promise<number> {
  try {
    const result = await restartArm(deps, arm_id);
    out.write(
      `Arm ${result.arm_id} restarted (restart_count=${result.restart_count}, ` +
        `previous_state=${result.previous_state})\n`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ArmRestartError) {
      out.write(`Error: ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Internal utilities
// ──────────────────────────────────────────────────────────────────────────

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
