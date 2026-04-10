// Octopus Orchestrator — Node Agent runtime loop (M2-03)
//
// References:
//   - LLD.md §"Node Agent Internals" (line ~522) — module composition
//   - LLD.md §"SessionReconciler behavior" (line ~533) — startup reconciliation
//   - DECISIONS.md OCTO-DEC-033 — boundary discipline (node:* builtins +
//     relative imports inside src/octo/ only)
//
// The Node Agent is a long-running process on a single machine that:
//   1. On startup: runs SessionReconciler to match live tmux sessions
//      against persisted arm rows. Recovered arms get ProcessWatcher.watch()
//      so their exits are detected.
//   2. Liveness polling loop: every N ms, for each arm in `starting` state
//      on this node, checks if the tmux session exists (batch once per tick)
//      and drives `starting -> active` or `starting -> failed` FSM transitions.
//   3. ProcessWatcher event handling: when ProcessWatcher emits a `failed`
//      or `completed` event for a watched arm, drives the FSM transition.
//   4. Clean shutdown: stop() clears the polling interval, stops
//      ProcessWatcher. Does NOT terminate tmux sessions.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { applyArmTransition, InvalidTransitionError } from "../head/arm-fsm.ts";
import type { EventLogService } from "../head/event-log.ts";
import type { AppendInput } from "../head/event-log.ts";
import { ConflictError } from "../head/registry.ts";
import type { ArmRecord, RegistryService } from "../head/registry.ts";
import { ProcessWatcher, type ProcessWatcherEvent } from "./process-watcher.ts";
import { SessionReconciler, type ReconciliationReport } from "./session-reconciler.ts";
import { TmuxManager } from "./tmux-manager.ts";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export interface NodeAgentOptions {
  nodeId: string;
  registry: RegistryService;
  eventLog: EventLogService;
  tmuxManager?: TmuxManager;
  pollIntervalMs?: number;
  processWatcherPollMs?: number;
  sessionNamePrefix?: string;
  /** Directory for sentinel files. Defaults to <os.tmpdir()>/octo-sentinels. */
  sentinelDir?: string;
  now?: () => number;
  logger?: (entry: {
    level: "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
  }) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_PROCESS_WATCHER_POLL_MS = 250;
const DEFAULT_SESSION_NAME_PREFIX = "octo-arm-";

// ──────────────────────────────────────────────────────────────────────────
// NodeAgent
// ──────────────────────────────────────────────────────────────────────────

export class NodeAgent {
  private readonly nodeId: string;
  private readonly registry: RegistryService;
  private readonly eventLog: EventLogService;
  private readonly tmuxManager: TmuxManager;
  private readonly pollIntervalMs: number;
  private readonly sessionNamePrefix: string;
  private readonly sentinelDir: string;
  private readonly nowFn: () => number;
  private readonly processWatcher: ProcessWatcher;
  private readonly reconciler: SessionReconciler;
  private readonly logger: NodeAgentOptions["logger"];

  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private pollInFlight = false;

  constructor(opts: NodeAgentOptions) {
    if (typeof opts.nodeId !== "string" || opts.nodeId.length === 0) {
      throw new Error("NodeAgent: nodeId must be a non-empty string");
    }
    this.nodeId = opts.nodeId;
    this.registry = opts.registry;
    this.eventLog = opts.eventLog;
    this.tmuxManager = opts.tmuxManager ?? new TmuxManager();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sessionNamePrefix = opts.sessionNamePrefix ?? DEFAULT_SESSION_NAME_PREFIX;
    this.sentinelDir =
      opts.sentinelDir ??
      path.join(
        // Use a temp-dir-based default for isolation
        process.env.TMPDIR ?? "/tmp",
        "octo-sentinels",
      );
    this.nowFn = opts.now ?? (() => Date.now());
    this.logger = opts.logger;

    this.processWatcher = new ProcessWatcher({
      pollIntervalMs: opts.processWatcherPollMs ?? DEFAULT_PROCESS_WATCHER_POLL_MS,
      tmuxManager: this.tmuxManager,
    });

    this.reconciler = new SessionReconciler(this.tmuxManager, this.registry, {
      nodeId: this.nodeId,
      sessionNamePrefix: this.sessionNamePrefix,
      now: this.nowFn,
      logger: this.logger,
    });

    // Wire up ProcessWatcher events.
    this.processWatcher.on("process", (event: ProcessWatcherEvent) => {
      void this.handleProcessEvent(event);
    });
  }

  /**
   * Start the agent: reconcile, attach watchers for active/starting arms,
   * begin the liveness polling loop.
   */
  async start(): Promise<ReconciliationReport> {
    if (this.running) {
      throw new Error("NodeAgent: already running");
    }

    // Ensure sentinel directory exists.
    mkdirSync(this.sentinelDir, { recursive: true });

    // Reconcile on startup.
    const report = await this.reconciler.reconcile();

    // Watch all starting/active arms for this node.
    const arms = this.registry.listArms({ node_id: this.nodeId });
    for (const arm of arms) {
      if (arm.state === "starting" || arm.state === "active") {
        this.watchArm(arm);
      }
    }

    // Start the polling loop.
    this.running = true;
    this.pollHandle = setInterval(() => {
      void this.pollTick();
    }, this.pollIntervalMs);

    return report;
  }

  /** Stop the agent cleanly. Does NOT terminate tmux sessions. */
  stop(): void {
    this.running = false;
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.processWatcher.stop();
  }

  /** Is the agent currently running? */
  isRunning(): boolean {
    return this.running;
  }

  /** Force a reconciliation pass (also runs on start). */
  async reconcile(): Promise<ReconciliationReport> {
    const report = await this.reconciler.reconcile();

    // Watch any newly-discovered starting/active arms.
    const arms = this.registry.listArms({ node_id: this.nodeId });
    for (const arm of arms) {
      if (arm.state === "starting" || arm.state === "active") {
        this.watchArm(arm);
      }
    }

    return report;
  }

  /** Compute the sentinel path for an arm. */
  sentinelPathForArm(arm_id: string): string {
    return path.join(this.sentinelDir, `${arm_id}.exit`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: polling
  // ────────────────────────────────────────────────────────────────────────

  private async pollTick(): Promise<void> {
    if (this.pollInFlight || !this.running) {
      return;
    }
    this.pollInFlight = true;
    try {
      // 1. Fetch all starting arms for this node.
      const startingArms = this.registry.listArms({
        node_id: this.nodeId,
        state: "starting",
      });

      if (startingArms.length === 0) {
        return;
      }

      // 2. Batch-fetch live tmux sessions once per tick.
      let liveNames: Set<string>;
      try {
        const names = await this.tmuxManager.listSessions();
        liveNames = new Set(names);
      } catch (err) {
        this.log("error", "pollTick: tmux listSessions failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return; // Skip this tick; do not crash.
      }

      // 3. For each starting arm, check liveness.
      for (const arm of startingArms) {
        const sessionName = `${this.sessionNamePrefix}${arm.arm_id}`;

        if (liveNames.has(sessionName)) {
          // Session is alive -- transition to active.
          await this.transitionArm(arm, "active", "arm.active");
          // Start watching for exit.
          this.watchArm(arm);
        } else {
          // Session not found -- transition to failed.
          await this.transitionArm(arm, "failed", "arm.failed", {
            reason: "session_not_found_on_poll",
          });
        }
      }
    } finally {
      this.pollInFlight = false;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: ProcessWatcher event handling
  // ────────────────────────────────────────────────────────────────────────

  private async handleProcessEvent(event: ProcessWatcherEvent): Promise<void> {
    const arm = this.registry.getArm(event.arm_id);
    if (arm === null) {
      this.log("warn", "handleProcessEvent: arm not found in registry", {
        arm_id: event.arm_id,
        event_type: event.type,
      });
      return;
    }

    // Only transition if the arm is in a state that can go to failed/completed.
    if (
      arm.state === "failed" ||
      arm.state === "terminated" ||
      arm.state === "archived" ||
      arm.state === "completed"
    ) {
      // Already in a terminal-ish state -- nothing to do.
      return;
    }

    if (event.type === "completed") {
      // completed means exit code 0. For arms that are active, this
      // maps to the completed state.
      await this.transitionArm(arm, "completed", "arm.completed", {
        exit_code: event.exit_code,
      });
    } else {
      // failed -- non-zero exit, sentinel missing, etc.
      await this.transitionArm(arm, "failed", "arm.failed", {
        exit_code: event.exit_code,
        reason: event.reason,
      });
    }

    this.processWatcher.unwatch(event.arm_id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: FSM transition helper
  // ────────────────────────────────────────────────────────────────────────

  private async transitionArm(
    arm: ArmRecord,
    toState: "active" | "failed" | "completed",
    eventType: AppendInput["event_type"],
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    const now = this.nowFn();

    // FSM validate + produce new state.
    let transitioned: { state: string; updated_at: number };
    try {
      transitioned = applyArmTransition({ state: arm.state, updated_at: arm.updated_at }, toState, {
        now,
        arm_id: arm.arm_id,
      });
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.log("warn", "transitionArm: FSM rejected transition", {
          arm_id: arm.arm_id,
          from: arm.state,
          to: toState,
        });
        return;
      }
      throw err;
    }

    // CAS update.
    try {
      this.registry.casUpdateArm(arm.arm_id, arm.version, {
        state: transitioned.state,
        updated_at: transitioned.updated_at,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        this.log("warn", "transitionArm: CAS conflict", {
          arm_id: arm.arm_id,
          expected_version: arm.version,
          actual_version: err.actualVersion,
        });
        return;
      }
      throw err;
    }

    // Emit event.
    try {
      await this.eventLog.append({
        schema_version: 1,
        entity_type: "arm",
        entity_id: arm.arm_id,
        event_type: eventType,
        ts: new Date(now).toISOString(),
        actor: `node-agent:${this.nodeId}`,
        payload: {
          node_id: this.nodeId,
          previous_state: arm.state,
          new_state: toState,
          ...extraPayload,
        },
      });
    } catch (err) {
      // Best-effort event emission -- do not crash the loop.
      this.log("error", "transitionArm: eventLog.append failed", {
        arm_id: arm.arm_id,
        event_type: eventType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: ProcessWatcher watch helper
  // ────────────────────────────────────────────────────────────────────────

  private watchArm(arm: ArmRecord): void {
    const sessionName = `${this.sessionNamePrefix}${arm.arm_id}`;
    this.processWatcher.watch({
      arm_id: arm.arm_id,
      session_name: sessionName,
      exit_sentinel_path: this.sentinelPathForArm(arm.arm_id),
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // Private: logging
  // ────────────────────────────────────────────────────────────────────────

  private log(
    level: "info" | "warn" | "error",
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (this.logger !== undefined) {
      this.logger({ level, message, details });
    }
  }
}
