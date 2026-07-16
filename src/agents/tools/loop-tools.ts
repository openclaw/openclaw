import { AsyncLocalStorage } from "node:async_hooks";
/**
 * Loop status, completion, phase, and update tools for the /loop command.
 *
 * Provides model-facing tools that let the agent read loop status,
 * explicitly signal task completion, navigate multi-phase loops,
 * and update subtask progress during a /loop session.
 *
 * All state is held in module-level variables shared between the TUI
 * controller and agent tools. Single-threaded TUI guarantees safety.
 */
import { Type } from "typebox";
import type { LoopPhase, LoopSubtask } from "../../loop/loop-types.js";
import { LOOP_PHASE_ORDER } from "../../loop/loop-types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

// ── Shared loop state ──────────────────────────────────────────────

export type LoopState = {
  task: string;
  iteration: number;
  maxIterations: number;
  consecutiveFailures: number;
  tokenBudget?: number;
  tokenUsage: number;
  sessionKey?: string;
  /** Set to true when the agent calls loop_complete */
  completed?: boolean;
  /** Summary provided by the agent on completion */
  completedSummary?: string;
  // ── Multi-phase fields ───────────────────────────────────────────
  /** Current active phase, or "idle" / "complete" */
  currentPhase: LoopPhase;
  /** Set to true by loop_update(phase_complete) when a phase is done */
  phaseComplete: boolean;
  /** Structured data from the last completed phase */
  phaseResult: Record<string, unknown> | null;
  /** Subtasks defined during the plan phase */
  subtasks: LoopSubtask[];
};

/** Session-scoped loop state storage */
const loopStates = new Map<string, LoopState | null>();
const stateChangeHistory: Array<{
  timestamp: string;
  sessionKey?: string;
  action: string;
  details: unknown;
}> = [];

/** Sets the session key for the current execution context (used by TUI) */
export function setCurrentSessionKey(sessionKey: string | undefined): void {
  if (sessionKey === undefined) {
    const alsKey = "openclaw.loop.sessionKey";
    try {
      const als = (globalThis as Record<PropertyKey, unknown>)[alsKey] as
        | AsyncLocalStorage<unknown>
        | undefined;
      if (als) {
        als.run(undefined, () => {});
      }
    } catch {}
  } else {
    const alsKey = "openclaw.loop.sessionKey";
    let als: AsyncLocalStorage<string> | undefined;
    try {
      als = (globalThis as Record<PropertyKey, unknown>)[alsKey] as
        | AsyncLocalStorage<string>
        | undefined;
    } catch {}
    if (!als) {
      als = new AsyncLocalStorage<string>();
      Object.defineProperty(globalThis, alsKey, {
        configurable: true,
        enumerable: false,
        value: als,
        writable: false,
      });
    }
    als.run(sessionKey, () => {});
  }
}

/** Resolves the effective session key from context */
function resolveSessionKey(): string {
  // 1) Check AsyncLocalStorage (set by setCurrentSessionKey or agent runner)
  try {
    const alsKey = "openclaw.loop.sessionKey";
    const als = (globalThis as Record<PropertyKey, unknown>)[alsKey] as
      | AsyncLocalStorage<unknown>
      | undefined;
    if (als) {
      const stored = als.getStore();
      if (stored && typeof stored === "string") {
        return stored;
      }
    }
  } catch {}
  // 2) Fallback to environment (used by isolated runs)
  if (process.env.OPENCLAW_SESSION_KEY) {
    return process.env.OPENCLAW_SESSION_KEY;
  }
  // 3) Single-session default
  return "default";
}

/** Logs state changes for audit trail */
function logStateChange(action: string, details?: unknown): void {
  stateChangeHistory.push({
    timestamp: new Date().toISOString(),
    sessionKey: resolveSessionKey(),
    action,
    details,
  });
  // Keep last 100 entries total
  while (stateChangeHistory.length > 100) {
    stateChangeHistory.shift();
  }
}

export function getStateChangeHistory(): Array<{
  timestamp: string;
  sessionKey?: string;
  action: string;
  details: unknown;
}> {
  return [...stateChangeHistory];
}

/** Gets loop state for the current session */
export function getLoopState(): LoopState | null {
  const key = resolveSessionKey();
  const state = loopStates.get(key);
  if (state !== undefined) {
    return state;
  }
  // Fallback: if only one session state exists, return it regardless of key.
  // This handles TUI → agent tool calls where ALS context may differ.
  const entries = Array.from(loopStates.entries()).filter(([, v]) => v !== null) as Array<
    [string, LoopState]
  >;
  if (entries.length === 1) {
    return entries[0]![1];
  }
  return null;
}

/** Sets loop state for the current session */
export function setLoopState(state: LoopState | null): void {
  const key = resolveSessionKey();
  const prev = loopStates.get(key);
  if (prev && state) {
    const validation = validateStateTransition(prev, state);
    if (!validation.valid) {
      console.error("[loop-tools] Invalid state transition:", validation.reason);
      return;
    }
  }
  if (state === null) {
    loopStates.delete(key);
  } else {
    loopStates.set(key, state);
  }
  logStateChange("setLoopState", {
    from: prev?.currentPhase ?? "null",
    to: state?.currentPhase ?? "null",
  });
}

/** Validates a state transition */
function validateStateTransition(
  oldState: LoopState,
  newState: LoopState,
): { valid: boolean; reason?: string } {
  // Phase transitions must not revert to earlier phases
  const oldIdx = LOOP_PHASE_ORDER.indexOf(oldState.currentPhase);
  const newIdx = LOOP_PHASE_ORDER.indexOf(newState.currentPhase);

  // Allow same phase or any forward advance (verify is embedded in execute phase,
  // so skipping verify when advancing execute→report is expected)
  if (newIdx < oldIdx) {
    return {
      valid: false,
      reason: `Cannot revert phase from ${oldState.currentPhase} to ${newState.currentPhase}`,
    };
  }

  return { valid: true };
}

// ── Helper to create a fresh loop state ────────────────────────────

export function createInitialLoopState(params: {
  task: string;
  maxIterations: number;
  tokenBudget?: number;
}): LoopState {
  return {
    task: params.task,
    iteration: 0,
    maxIterations: params.maxIterations,
    consecutiveFailures: 0,
    tokenBudget: params.tokenBudget,
    tokenUsage: 0,
    currentPhase: "analyze",
    phaseComplete: false,
    phaseResult: null,
    subtasks: [],
  };
}

// ── Tool: loop_status (existing, extended) ─────────────────────────

const LoopStatusToolSchema = Type.Object({});

/** Creates the read-only tool that returns the current loop status. */
export function createLoopStatusTool(): AnyAgentTool {
  return {
    label: "Loop Status",
    name: "loop_status",
    displaySummary: "Check the autonomous loop status",
    description:
      "Get the current /loop status, including iteration count, token usage, and remaining budget. Use this to check progress or decide whether to continue.",
    parameters: LoopStatusToolSchema,
    execute: async () => {
      const state = getLoopState();
      if (!state) {
        return jsonResult({ active: false, message: "No active /loop session" });
      }
      try {
        const diagnostics = generateLoopDiagnostics(state);
        return jsonResult({
          active: true,
          task: state.task,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          remainingIterations: Math.max(0, state.maxIterations - state.iteration),
          tokenUsage: state.tokenUsage,
          tokenBudget: state.tokenBudget ?? null,
          consecutiveFailures: state.consecutiveFailures,
          // Phase info
          phase: state.currentPhase,
          phaseComplete: state.phaseComplete,
          subtaskCount: state.subtasks.length,
          completedSubtasks: state.subtasks.filter((s) => s.status === "complete").length,
          // Diagnostics
          isBlocked: diagnostics.isBlocked,
          blockReason: diagnostics.blockReason,
          cycleTime: diagnostics.cycleTime,
        });
      } catch (error) {
        console.error("[loop-tools] Error generating status:", error);
        return jsonResult({
          active: true,
          task: state.task,
          error: "Failed to generate full status",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

// ── Tool: loop_complete (existing, unchanged) ──────────────────────

const LoopCompleteToolSchema = Type.Object({
  summary: Type.String({
    description: "Summary of what was accomplished.",
  }),
});

/** Creates the tool that signals loop completion from the agent side. */
export function createLoopCompleteTool(): AnyAgentTool {
  return {
    label: "Loop Complete",
    name: "loop_complete",
    displaySummary: "Signal that the loop task is complete",
    description:
      "Call this tool when the loop task has been fully completed. Provide a summary of what was accomplished. After calling this, the /loop will terminate automatically.",
    parameters: LoopCompleteToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const state = getLoopState();
      const summary = typeof params.summary === "string" ? params.summary : "";
      if (state) {
        state.completed = true;
        state.completedSummary = summary;
        state.currentPhase = "complete";
      }
      return jsonResult({
        acknowledged: true,
        task: state?.task ?? "(unknown)",
        summary,
        message: "Task completion acknowledged. The loop will terminate after this turn.",
      });
    },
  };
}

// ── Tool: loop_phase (new) ─────────────────────────────────────────

const LoopPhaseToolSchema = Type.Object({});

/** Creates the tool that returns the current multi-phase loop status. */
export function createLoopPhaseTool(): AnyAgentTool {
  return {
    label: "Loop Phase Status",
    name: "loop_phase",
    displaySummary: "Check the current loop phase",
    description:
      "Get the current phase, completed phases, pending subtasks, and overall progress in the multi-phase /loop workflow.",
    parameters: LoopPhaseToolSchema,
    execute: async () => {
      const state = getLoopState();
      if (!state) {
        return jsonResult({ active: false, message: "No active /loop session" });
      }

      const phaseIndex = LOOP_PHASE_ORDER.indexOf(state.currentPhase);
      const totalPhases = LOOP_PHASE_ORDER.length;
      const completedPhases =
        state.currentPhase === "complete"
          ? LOOP_PHASE_ORDER
          : LOOP_PHASE_ORDER.slice(0, phaseIndex);

      return jsonResult({
        active: true,
        currentPhase: state.currentPhase,
        phaseIndex: Math.max(0, phaseIndex),
        totalPhases,
        completedPhases,
        remainingPhases: LOOP_PHASE_ORDER.slice(
          Math.max(0, phaseIndex === -1 ? 0 : phaseIndex + 1),
        ),
        phaseComplete: state.phaseComplete,
        subtasks: state.subtasks.map((s) => ({
          id: s.id,
          name: s.name,
          status: s.status,
          dependencies: s.dependencies,
        })),
      });
    },
  };
}

// ── Tool: loop_update (new) ────────────────────────────────────────

const LoopUpdateToolSchema = Type.Object({
  action: Type.String({
    description:
      '"phase_complete" — mark the current phase as done with results. ' +
      '"subtask_status" — update a subtask\'s status and result.',
  }),
  phase: Type.Optional(Type.String({ description: "Phase name (required for phase_complete)." })),
  summary: Type.Optional(
    Type.String({ description: "Summary of what was accomplished (required for phase_complete)." }),
  ),
  subtaskId: Type.Optional(
    Type.String({ description: "Subtask ID (required for subtask_status)." }),
  ),
  subtaskStatus: Type.Optional(
    Type.String({ description: "New subtask status: pending | in-progress | complete | failed." }),
  ),
  result: Type.Optional(
    Type.String({ description: "Detailed result from executing or verifying a subtask." }),
  ),
  passed: Type.Optional(Type.Boolean({ description: "Whether verification passed." })),
  subtasks: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
        acceptanceCriteria: Type.Array(Type.String()),
        dependencies: Type.Array(Type.String()),
        parallelizable: Type.Boolean(),
      }),
      {
        description: "Subtask definitions (required for phase_complete during plan phase).",
      },
    ),
  ),
});

/** Creates the tool that updates loop phase and subtask state. */
export function createLoopUpdateTool(): AnyAgentTool {
  return {
    label: "Loop Update",
    name: "loop_update",
    displaySummary: "Update loop phase or subtask state",
    description:
      "Update the /loop state: mark the current phase as complete with results, or update a subtask's status. " +
      "Use this to report progress and advance the loop workflow.",
    parameters: LoopUpdateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const state = getLoopState();
      if (!state) {
        return jsonResult({
          acknowledged: false,
          error: "No active /loop session. Start a loop first.",
        });
      }

      const action = typeof params.action === "string" ? params.action : "";

      if (action === "phase_complete") {
        const phase = typeof params.phase === "string" ? params.phase : state.currentPhase;
        const summary = typeof params.summary === "string" ? params.summary : "";
        const subtaskId = typeof params.subtaskId === "string" ? params.subtaskId : undefined;
        const subtasks = params.subtasks as
          | Array<{
              id: string;
              name: string;
              description: string;
              acceptanceCriteria: string[];
              dependencies: string[];
              parallelizable: boolean;
            }>
          | undefined;

        state.phaseComplete = true;
        state.phaseResult = {
          phase,
          summary,
          subtaskId,
          passed: params.passed === true,
          details: {},
        };

        // Store subtasks from plan phase
        if (subtasks && Array.isArray(subtasks) && subtasks.length > 0) {
          state.subtasks = subtasks.map((s) => {
            const out = s as LoopSubtask;
            out.status = "pending" as const;
            return out;
          });
        }

        return jsonResult({
          acknowledged: true,
          action: "phase_complete",
          phase,
          summary,
          message: `Phase "${phase}" marked complete. The loop will advance to the next phase.`,
        });
      }

      if (action === "subtask_status") {
        const subtaskId = typeof params.subtaskId === "string" ? params.subtaskId : "";
        const status = typeof params.subtaskStatus === "string" ? params.subtaskStatus : "";
        const result = typeof params.result === "string" ? params.result : undefined;

        if (!subtaskId) {
          return jsonResult({
            acknowledged: false,
            error: "subtaskId is required for subtask_status update.",
          });
        }

        const subtask = state.subtasks.find((s) => s.id === subtaskId);
        if (!subtask) {
          return jsonResult({
            acknowledged: false,
            error: `Subtask "${subtaskId}" not found.`,
          });
        }

        if (
          status === "in-progress" ||
          status === "complete" ||
          status === "failed" ||
          status === "skipped"
        ) {
          subtask.status = status;
        }
        if (result) {
          subtask.result = result;
        }

        return jsonResult({
          acknowledged: true,
          action: "subtask_status",
          subtaskId,
          status: subtask.status,
          message: `Subtask "${subtask.name}" status updated to ${status}.`,
        });
      }

      return jsonResult({
        acknowledged: false,
        error: `Unknown action "${action}". Use "phase_complete" or "subtask_status".`,
      });
    },
  };
}

// ── Diagnostic & Validation Utilities ───────────────────────────────

/** Computes next phase based on current phase and transition rules */
function computeNextPhase(currentPhase: LoopPhase): LoopPhase | null {
  const idx = LOOP_PHASE_ORDER.indexOf(currentPhase);
  if (idx === -1) {
    return null;
  }
  return LOOP_PHASE_ORDER[idx + 1] ?? null;
}

/** Generates diagnostics for the current loop state */
function generateLoopDiagnostics(state: LoopState): {
  state: {
    task: string;
    sessionKey: string | undefined;
    createdAt: string;
    updatedAt: string;
    version: string;
    totalIterations: number;
    completedPhases: string[];
  };
  activeSubtasks: number;
  pendingSubtasks: number;
  failedSubtasks: number;
  skippedSubtasks: number;
  nextPhase: string | null;
  isBlocked: boolean;
  blockReason: string | undefined;
  cycleTime: number;
} {
  const now = Date.now();
  const firstStarted = state.subtasks.find((s) => s.startedAt);
  const startTime = firstStarted ? new Date(firstStarted.startedAt!).getTime() : now;
  const cycleTime = (now - startTime) / 1000;

  const activeSubtasks = state.subtasks.filter((s) => s.status === "in-progress").length;
  const pendingSubtasks = state.subtasks.filter((s) => s.status === "pending").length;
  const failedSubtasks = state.subtasks.filter((s) => s.status === "failed").length;
  const skippedSubtasks = state.subtasks.filter((s) => s.status === "skipped").length;

  // Check for deadlocks: pending subtasks whose dependencies are not all complete
  const blockedSubtasks: string[] = [];
  for (const subtask of state.subtasks) {
    if (subtask.status === "pending") {
      const depsComplete = subtask.dependencies.every((depId) => {
        const dep = state.subtasks.find((s) => s.id === depId);
        return dep && dep.status === "complete";
      });
      if (!depsComplete) {
        blockedSubtasks.push(subtask.name);
      }
    }
  }

  const isBlocked = blockedSubtasks.length > 0 && pendingSubtasks > 0;

  return {
    state: {
      task: state.task,
      sessionKey: state.sessionKey,
      createdAt: state.subtasks[0]?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: "1.0",
      totalIterations: state.iteration,
      completedPhases: state.currentPhase ? [state.currentPhase] : [],
    },
    activeSubtasks,
    pendingSubtasks,
    failedSubtasks,
    skippedSubtasks,
    nextPhase: computeNextPhase(state.currentPhase),
    isBlocked,
    blockReason: isBlocked
      ? `Pending subtasks blocked by dependencies: ${blockedSubtasks.join(", ")}`
      : undefined,
    cycleTime,
  };
}

/** Validates subtask dependency graph for cycles */
/** Get diagnostic summary for all active sessions (admin/debug) */
export function getActiveSessionsDiagnostic() {
  return {
    totalSessions: loopStates.size,
    sessions: Array.from(loopStates.entries()).map(([key, state]) => ({
      sessionKey: key,
      sessionState: state,
      task: state?.task,
      phase: state?.currentPhase,
      iteration: state?.iteration,
      completed: state?.completed,
    })),
  };
}

export function validateSubtaskDependencies(subtasks: LoopSubtask[]): {
  valid: boolean;
  cycle?: string[];
} {
  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycle: string[] = [];

  function dfs(id: string, path: string[]): boolean {
    if (recStack.has(id)) {
      const cycleStart = path.indexOf(id);
      cycle.push(...path.slice(cycleStart), id);
      return true; // cycle detected
    }
    if (visited.has(id)) {
      return false;
    }

    visited.add(id);
    recStack.add(id);
    path.push(id);

    const subtask = subtasks.find((s) => s.id === id);
    if (subtask) {
      for (const dep of subtask.dependencies) {
        if (dfs(dep, [...path])) {
          return true;
        }
      }
    }

    recStack.delete(id);
    return false;
  }

  for (const s of subtasks) {
    if (!visited.has(s.id)) {
      if (dfs(s.id, [])) {
        break;
      }
    }
  }

  return { valid: cycle.length === 0, cycle: cycle.length > 0 ? cycle : undefined };
}

/** Checks for deadlock in subtask dependency graph */
export function checkForDeadlocks(state: LoopState): {
  deadlocked: boolean;
  blockedSubtasks?: string[];
} {
  const pending = state.subtasks.filter((s) => s.status === "pending");
  if (pending.length === 0) {
    return { deadlocked: false };
  }

  // Check if any pending subtask can eventually complete
  const canComplete = (subtask: LoopSubtask, visited: Set<string> = new Set()): boolean => {
    if (visited.has(subtask.id)) {
      return false;
    } // cycle
    visited.add(subtask.id);

    if (subtask.dependencies.length === 0) {
      return true;
    }

    return subtask.dependencies.every((depId) => {
      const dep = state.subtasks.find((s) => s.id === depId);
      if (!dep) {
        return false;
      } // missing dep
      if (dep.status === "complete") {
        return true;
      }
      if (dep.status === "failed" || dep.status === "skipped") {
        return false;
      }
      return canComplete(dep, visited);
    });
  };

  const blockedSubtasks = pending.filter((s) => !canComplete(s)).map((s) => s.name);

  return {
    deadlocked: blockedSubtasks.length === pending.length && pending.length > 0,
    blockedSubtasks,
  };
}
