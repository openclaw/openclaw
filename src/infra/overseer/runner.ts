import crypto from "node:crypto";

import { loadConfig } from "../../config/config.js";
import { parseDurationMs } from "../../cli/parse-duration.js";
import { getQueueSize } from "../../process/command-queue.js";
import { CommandLane } from "../../process/lanes.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.js";
import { appendOverseerEvent } from "./events.js";
import { executeOverseerActions, type OverseerDispatchAction } from "./dispatcher.js";
import { createOverseerMonitor, type OverseerTelemetrySnapshot } from "./monitor.js";
import { generateOverseerPlan } from "./planner.js";
import { updateOverseerStore, loadOverseerStoreFromDisk } from "./store.js";
import type {
  OverseerAssignmentRecord,
  OverseerGoalRecord,
  OverseerPlanNodeBase,
  OverseerStore,
  OverseerStructuredUpdate,
  OverseerWorkStatus,
} from "./store.types.js";
import { requestOverseerNow, setOverseerWakeHandler, type OverseerTickResult } from "./wake.js";

const log = createSubsystemLogger("gateway/overseer");

const DEFAULT_TICK_EVERY = "2m";
const DEFAULT_IDLE_AFTER = "15m";
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MIN_RESEND = "5m";
const DEFAULT_BACKOFF_BASE = "2m";
const DEFAULT_BACKOFF_MAX = "30m";

type OverseerResolvedConfig = {
  enabled: boolean;
  tickEveryMs: number | null;
  idleAfterMs: number;
  maxRetries: number;
  minResendIntervalMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  allowAgents: Set<string>;
  allowAnyAgent: boolean;
  allowCrossAgent: boolean;
  defaultAgentId: string;
};

export type OverseerRunnerHooks = {
  /** Called when an assignment transitions to stalled */
  onAssignmentStalled?: (assignment: OverseerAssignmentRecord) => void;
  /** Called when an assignment becomes active */
  onAssignmentActive?: (assignment: OverseerAssignmentRecord) => void;
  /** Called when an assignment is done */
  onAssignmentDone?: (assignment: OverseerAssignmentRecord) => void;
  /** Called before actions are dispatched, can modify or filter actions */
  onBeforeDispatch?: (actions: OverseerDispatchAction[]) => OverseerDispatchAction[] | void;
  /** Called after a tick completes */
  onTickComplete?: (result: { didWork: boolean; actionCount: number }) => void;
};

export type OverseerRunner = {
  stop: () => void;
  updateConfig: (cfg: ReturnType<typeof loadConfig>) => void;
  tickNow: (opts?: { reason?: string }) => Promise<{ ok: boolean; didWork: boolean }>;
  /** Update hooks at runtime */
  updateHooks: (hooks: OverseerRunnerHooks) => void;
};

type StatusTransition = {
  assignmentId: string;
  assignment: OverseerAssignmentRecord;
  from: OverseerAssignmentRecord["status"];
  to: OverseerAssignmentRecord["status"];
};

type TickOutcome = {
  actions: OverseerDispatchAction[];
  didWork: boolean;
  preDispatchStore: OverseerStore;
  statusTransitions: StatusTransition[];
};

function resolveOverseerConfig(cfg = loadConfig()): OverseerResolvedConfig {
  const safeDuration = (value: string, fallback: number): number => {
    try {
      return parseDurationMs(value);
    } catch {
      return fallback;
    }
  };
  const enabled = cfg.overseer?.enabled === true;
  const tickEveryMs = (() => {
    try {
      return parseDurationMs(cfg.overseer?.tickEvery ?? DEFAULT_TICK_EVERY);
    } catch {
      return null;
    }
  })();
  const idleAfterMs = safeDuration(cfg.overseer?.idleAfter ?? DEFAULT_IDLE_AFTER, 15 * 60_000);
  const maxRetries = Math.max(0, Math.floor(cfg.overseer?.maxRetries ?? DEFAULT_MAX_RETRIES));
  const minResendIntervalMs = safeDuration(
    cfg.overseer?.minResendInterval ?? DEFAULT_MIN_RESEND,
    5 * 60_000,
  );
  const backoffBaseMs = safeDuration(
    cfg.overseer?.backoff?.base ?? DEFAULT_BACKOFF_BASE,
    2 * 60_000,
  );
  const backoffMaxMs = safeDuration(cfg.overseer?.backoff?.max ?? DEFAULT_BACKOFF_MAX, 30 * 60_000);
  const allowCrossAgent = cfg.overseer?.policy?.allowCrossAgent === true;
  const allowAgentsRaw = cfg.overseer?.policy?.allowAgents ?? [];
  const allowAnyAgent = allowAgentsRaw.some((value) => value.trim() === "*");
  const allowAgents = new Set(
    allowAgentsRaw
      .filter((value) => value.trim() && value.trim() !== "*")
      .map((value) => normalizeAgentId(value)),
  );
  return {
    enabled,
    tickEveryMs,
    idleAfterMs,
    maxRetries,
    minResendIntervalMs,
    backoffBaseMs,
    backoffMaxMs,
    allowAgents,
    allowAnyAgent,
    allowCrossAgent,
    defaultAgentId: normalizeAgentId(resolveDefaultAgentId(cfg)),
  };
}

function hashInstruction(text: string): string {
  const hash = crypto.createHash("sha256");
  hash.update(text, "utf8");
  return hash.digest("hex");
}

function buildNudgeMessage(params: {
  goalId: string;
  workNodeId: string;
  title: string;
  objective?: string;
  acceptance?: string[];
}): string {
  return [
    `Overseer status check for ${params.title}.`,
    params.objective ? `Objective: ${params.objective}` : "",
    params.acceptance?.length ? `Acceptance:\n- ${params.acceptance.join("\n- ")}` : "",
    "",
    "Please reply with a structured update in a fenced json block:",
    "```json",
    JSON.stringify(
      {
        overseerUpdate: {
          goalId: params.goalId,
          workNodeId: params.workNodeId,
          status: "in_progress",
          summary: "What changed since last instruction",
          next: "Next concrete action",
          blockers: [],
          evidence: {
            filesTouched: [],
            testsRun: [],
            commits: [],
          },
        },
      },
      null,
      2,
    ),
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

function findWorkNode(goal: OverseerGoalRecord, workNodeId: string): OverseerPlanNodeBase | null {
  const plan = goal.plan;
  if (!plan) return null;
  for (const phase of plan.phases) {
    if (phase.id === workNodeId) return phase;
    for (const task of phase.tasks) {
      if (task.id === workNodeId) return task;
      for (const subtask of task.subtasks) {
        if (subtask.id === workNodeId) return subtask;
      }
    }
  }
  return null;
}

function updateRollups(goal: OverseerGoalRecord) {
  const plan = goal.plan;
  if (!plan) return;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (task.subtasks.length === 0) continue;
      if (task.subtasks.every((subtask) => subtask.status === "done")) {
        task.status = "done";
      } else if (task.subtasks.some((subtask) => subtask.status === "in_progress")) {
        task.status = "in_progress";
      }
      task.updatedAt = Date.now();
    }
    if (phase.tasks.length > 0 && phase.tasks.every((task) => task.status === "done")) {
      phase.status = "done";
    } else if (phase.tasks.some((task) => task.status === "in_progress")) {
      phase.status = "in_progress";
    }
    phase.updatedAt = Date.now();
  }
  if (plan.phases.length > 0 && plan.phases.every((phase) => phase.status === "done")) {
    goal.status = "completed";
  }
  goal.updatedAt = Date.now();
}

function isAssignmentAllowed(cfg: OverseerResolvedConfig, assignment: OverseerAssignmentRecord) {
  if (!cfg.allowCrossAgent) {
    const targetAgent = normalizeAgentId(
      assignment.agentId ?? resolveAgentIdFromSessionKey(assignment.sessionKey),
    );
    return targetAgent === cfg.defaultAgentId;
  }
  if (cfg.allowAnyAgent) return true;
  const agentId = normalizeAgentId(
    assignment.agentId ?? resolveAgentIdFromSessionKey(assignment.sessionKey),
  );
  if (cfg.allowAgents.size === 0) return agentId === cfg.defaultAgentId;
  return cfg.allowAgents.has(agentId);
}

function shouldDispatch(params: {
  assignment: OverseerAssignmentRecord;
  now: number;
  minResendIntervalMs: number;
}): boolean {
  const { assignment, now, minResendIntervalMs } = params;
  if (assignment.backoffUntil && assignment.backoffUntil > now) return false;
  if (assignment.lastDispatchAt && assignment.instructionHash) {
    const elapsed = now - assignment.lastDispatchAt;
    if (elapsed < minResendIntervalMs) return false;
  }
  return true;
}

function resolveBackoffUntil(now: number, retryCount: number, cfg: OverseerResolvedConfig) {
  const pow = Math.min(10, retryCount);
  const base = cfg.backoffBaseMs * Math.pow(2, pow);
  const clamped = Math.min(cfg.backoffMaxMs, base);
  return now + clamped;
}

function resolveExpectedNextUpdateAt(now: number, idleAfterMs: number) {
  return now + idleAfterMs;
}

export function applyStructuredUpdate(params: {
  store: OverseerStore;
  assignment: OverseerAssignmentRecord;
  update: OverseerStructuredUpdate;
  now: number;
}) {
  const goal = params.store.goals[params.assignment.goalId];
  if (!goal) return;
  const workNode = params.update.workNodeId
    ? findWorkNode(goal, params.update.workNodeId)
    : findWorkNode(goal, params.assignment.workNodeId);
  const status =
    params.update.status === "done" ||
    params.update.status === "blocked" ||
    params.update.status === "in_progress"
      ? (params.update.status as OverseerWorkStatus)
      : undefined;
  if (workNode && status) {
    workNode.status = status;
    workNode.updatedAt = params.now;
    if (status === "done") {
      workNode.endedAt = params.now;
    } else if (status === "in_progress") {
      workNode.startedAt = workNode.startedAt ?? params.now;
    }
  }
  if (params.update.blockers?.length) {
    params.assignment.blockedReason = params.update.blockers.join("; ").slice(0, 2000);
    params.assignment.status = "blocked";
  }
  if (params.update.status === "done") {
    params.assignment.status = "done";
  } else if (params.update.status === "in_progress") {
    params.assignment.status = "active";
  }
  params.assignment.updatedAt = params.now;
  if (
    params.update.summary ||
    params.update.next ||
    params.update.blockers?.length ||
    params.update.evidence
  ) {
    const crystallizationId = `C_${crypto.randomUUID()}`;
    params.store.crystallizations[crystallizationId] = {
      crystallizationId,
      goalId: params.assignment.goalId,
      workNodeId: params.assignment.workNodeId,
      summary: params.update.summary,
      currentState: undefined,
      nextActions: params.update.next ? [params.update.next] : undefined,
      knownBlockers: params.update.blockers,
      evidence: params.update.evidence,
      createdAt: params.now,
      transcriptAnchors: {
        sessionKey: params.assignment.sessionKey,
        runId: params.assignment.runId,
      },
    };
    appendOverseerEvent(params.store, {
      ts: params.now,
      type: "crystallization.created",
      goalId: params.assignment.goalId,
      assignmentId: params.assignment.assignmentId,
      workNodeId: params.assignment.workNodeId,
      data: { crystallizationId },
    });
  }
  updateRollups(goal);
}

export function reconcileOverseerState(params: {
  store: OverseerStore;
  telemetry: OverseerTelemetrySnapshot;
  cfg: OverseerResolvedConfig;
  now: number;
}): TickOutcome {
  const { store, telemetry, cfg, now } = params;
  const actions: OverseerDispatchAction[] = [];
  const statusTransitions: StatusTransition[] = [];
  const assignments = Object.values(store.assignments ?? {});

  // Capture initial statuses for transition tracking
  const initialStatuses = new Map<string, OverseerAssignmentRecord["status"]>();
  for (const assignment of assignments) {
    initialStatuses.set(assignment.assignmentId, assignment.status);
  }

  for (const assignment of assignments) {
    if (!isAssignmentAllowed(cfg, assignment)) continue;
    const goal = store.goals[assignment.goalId];
    if (!goal) continue;
    const goalIsActive = goal.status === "active";
    const telemetryEntry = telemetry.assignments[assignment.assignmentId];
    if (telemetryEntry?.structuredUpdate) {
      applyStructuredUpdate({
        store,
        assignment,
        update: telemetryEntry.structuredUpdate,
        now,
      });
      appendOverseerEvent(store, {
        ts: now,
        type: "overseer.update.structured",
        goalId: assignment.goalId,
        assignmentId: assignment.assignmentId,
        workNodeId: assignment.workNodeId,
      });
    }

    if (telemetryEntry?.deliveryContext && !assignment.deliveryContext) {
      assignment.deliveryContext = telemetryEntry.deliveryContext;
    }

    if (telemetryEntry?.runActive) {
      assignment.lastObservedActivityAt = now;
      if (
        assignment.status !== "done" &&
        assignment.status !== "blocked" &&
        assignment.status !== "cancelled"
      ) {
        assignment.status = "active";
      }
    } else if (
      telemetryEntry?.sessionUpdatedAt &&
      assignment.lastDispatchAt &&
      telemetryEntry.sessionUpdatedAt > assignment.lastDispatchAt
    ) {
      assignment.lastObservedActivityAt = telemetryEntry.sessionUpdatedAt;
      if (
        assignment.status !== "done" &&
        assignment.status !== "blocked" &&
        assignment.status !== "cancelled"
      ) {
        assignment.status = "active";
      }
    } else if (
      telemetryEntry?.lastMessageFingerprint &&
      telemetryEntry.lastMessageFingerprint !== assignment.lastMessageFingerprint
    ) {
      assignment.lastObservedActivityAt = now;
      assignment.lastMessageFingerprint = telemetryEntry.lastMessageFingerprint;
      if (
        assignment.status !== "done" &&
        assignment.status !== "blocked" &&
        assignment.status !== "cancelled"
      ) {
        assignment.status = "active";
      }
    }

    const lastActivity =
      assignment.lastObservedActivityAt ?? assignment.lastDispatchAt ?? assignment.updatedAt;
    const idleAfterMs = assignment.idleAfterMs ?? cfg.idleAfterMs;
    const wasStalled = assignment.status === "stalled";
    const isOverdue =
      (assignment.expectedNextUpdateAt && assignment.expectedNextUpdateAt <= now) ||
      (lastActivity && now - lastActivity > idleAfterMs);
    if (
      goalIsActive &&
      isOverdue &&
      assignment.status !== "done" &&
      assignment.status !== "blocked" &&
      assignment.status !== "cancelled"
    ) {
      assignment.status = "stalled";
      if (!wasStalled) {
        appendOverseerEvent(store, {
          ts: now,
          type: "assignment.stalled",
          goalId: assignment.goalId,
          assignmentId: assignment.assignmentId,
          workNodeId: assignment.workNodeId,
        });
      }
    }

    if (!goalIsActive) {
      continue;
    }

    if (assignment.status === "queued") {
      const workNode = findWorkNode(goal, assignment.workNodeId);
      const title = workNode?.name ?? assignment.workNodeId;
      const message = buildNudgeMessage({
        goalId: assignment.goalId,
        workNodeId: assignment.workNodeId,
        title,
        objective: workNode?.objective,
        acceptance: workNode?.acceptanceCriteria,
      });
      const instructionHash = hashInstruction(message);
      if (shouldDispatch({ assignment, now, minResendIntervalMs: cfg.minResendIntervalMs })) {
        const dispatchId = crypto.randomUUID();
        assignment.lastInstructionText = message;
        assignment.instructionHash = instructionHash;
        assignment.lastDispatchAt = now;
        assignment.expectedNextUpdateAt = resolveExpectedNextUpdateAt(now, idleAfterMs);
        assignment.status = "dispatched";
        assignment.updatedAt = now;
        assignment.dispatchHistory.push({
          dispatchId,
          ts: now,
          mode: "sessions_send",
          target: { sessionKey: assignment.sessionKey },
          instructionHash,
          result: "accepted",
        });
        appendOverseerEvent(store, {
          ts: now,
          type: "assignment.dispatched",
          goalId: assignment.goalId,
          assignmentId: assignment.assignmentId,
          workNodeId: assignment.workNodeId,
          data: { type: "initial" },
        });
        if (assignment.sessionKey) {
          actions.push({
            type: "nudge",
            assignmentId: assignment.assignmentId,
            sessionKey: assignment.sessionKey,
            message,
            dispatchId,
          });
        }
      }
      continue;
    }

    if (assignment.status === "stalled") {
      const retryCount = assignment.retryCount ?? 0;
      if (!shouldDispatch({ assignment, now, minResendIntervalMs: cfg.minResendIntervalMs })) {
        continue;
      }
      const shouldNudge = retryCount < cfg.maxRetries;
      const actionType = shouldNudge ? "nudge" : (assignment.recoveryPolicy ?? "escalate");
      const lastDispatch = assignment.dispatchHistory[assignment.dispatchHistory.length - 1];
      const reuseDispatchId =
        actionType === "resend_last" &&
        lastDispatch?.dispatchId &&
        lastDispatch.result &&
        lastDispatch.result !== "ok";
      const dispatchId = reuseDispatchId ? lastDispatch.dispatchId : crypto.randomUUID();
      assignment.retryCount = retryCount + 1;
      assignment.lastRetryAt = now;
      assignment.backoffUntil = resolveBackoffUntil(now, assignment.retryCount, cfg);
      assignment.expectedNextUpdateAt = resolveExpectedNextUpdateAt(now, idleAfterMs);
      const message =
        assignment.lastInstructionText ??
        buildNudgeMessage({
          goalId: assignment.goalId,
          workNodeId: assignment.workNodeId,
          title: assignment.workNodeId,
        });
      const instructionHash = hashInstruction(message);
      assignment.lastInstructionText = message;
      assignment.instructionHash = instructionHash;
      assignment.lastDispatchAt = now;
      assignment.updatedAt = now;
      if (actionType !== "replan") {
        if (reuseDispatchId && lastDispatch) {
          lastDispatch.ts = now;
          lastDispatch.result = "accepted";
          lastDispatch.instructionHash = instructionHash;
        } else {
          assignment.dispatchHistory.push({
            dispatchId,
            ts: now,
            mode: actionType === "escalate" ? "escalate" : "sessions_send",
            target:
              actionType === "escalate"
                ? { deliveryContext: assignment.deliveryContext }
                : { sessionKey: assignment.sessionKey },
            instructionHash,
            result: "accepted",
          });
        }
      }
      appendOverseerEvent(store, {
        ts: now,
        type: `assignment.${actionType}`,
        goalId: assignment.goalId,
        assignmentId: assignment.assignmentId,
        workNodeId: assignment.workNodeId,
      });
      if (actionType === "nudge" || actionType === "resend_last") {
        if (assignment.sessionKey) {
          actions.push({
            type: actionType === "resend_last" ? "resend" : "nudge",
            assignmentId: assignment.assignmentId,
            sessionKey: assignment.sessionKey,
            message,
            dispatchId,
          });
        }
      } else if (actionType === "reassign") {
        actions.push({
          type: "spawn",
          assignmentId: assignment.assignmentId,
          message,
          agentId: assignment.agentId,
          dispatchId,
          requesterSessionKey: assignment.sessionKey,
          requesterOrigin: assignment.deliveryContext ?? undefined,
        });
      } else if (actionType === "replan") {
        // handled by runner before dispatch
      } else if (actionType === "escalate") {
        const deliveryContext = normalizeDeliveryContext(assignment.deliveryContext);
        if (deliveryContext) {
          actions.push({
            type: "escalate",
            assignmentId: assignment.assignmentId,
            message,
            deliveryContext,
            dispatchId,
            sessionKey: assignment.sessionKey,
          });
        }
      }
    }
  }

  // Compute status transitions
  for (const assignment of assignments) {
    const initialStatus = initialStatuses.get(assignment.assignmentId);
    if (initialStatus && initialStatus !== assignment.status) {
      statusTransitions.push({
        assignmentId: assignment.assignmentId,
        assignment,
        from: initialStatus,
        to: assignment.status,
      });
    }
  }

  return {
    actions,
    didWork: actions.length > 0 || statusTransitions.length > 0,
    preDispatchStore: store,
    statusTransitions,
  };
}

async function maybeApplyPlanner(store: OverseerStore, now: number): Promise<boolean> {
  const stalledAssignments = Object.values(store.assignments ?? {}).filter(
    (assignment) => assignment.status === "stalled" && assignment.recoveryPolicy === "replan",
  );
  if (stalledAssignments.length === 0) return false;
  let mutated = false;
  for (const assignment of stalledAssignments) {
    const goal = store.goals[assignment.goalId];
    if (!goal) continue;
    if (goal.status !== "active") continue;
    if (!goal.problemStatement || !goal.title) continue;
    try {
      const planResult = await generateOverseerPlan({
        goalTitle: goal.title,
        problemStatement: goal.problemStatement,
        successCriteria: goal.successCriteria ?? [],
        constraints: goal.constraints ?? [],
        repoContextSnapshot: goal.repoContextSnapshot,
        agentId: assignment.agentId,
      });
      goal.plan = planResult.plan;
      goal.rawPlannerOutputJson = planResult.rawJson;
      goal.validationErrors = planResult.validationErrors;
      goal.planner = {
        modelRef: loadConfig().overseer?.planner?.model,
        promptTemplateId: planResult.promptTemplateId,
        promptTemplateHash: planResult.promptTemplateHash,
      };
      goal.planRevisionHistory = [
        ...(goal.planRevisionHistory ?? []),
        { ts: now, summary: "replan due to stalled assignment" },
      ];
      mutated = true;
      appendOverseerEvent(store, {
        ts: now,
        type: "plan.regenerated",
        goalId: goal.goalId,
      });
    } catch (err) {
      appendOverseerEvent(store, {
        ts: now,
        type: "plan.replan.failed",
        goalId: goal.goalId,
        data: { error: String(err) },
      });
    }
  }
  return mutated;
}

export async function runOverseerTick(opts?: {
  reason?: string;
  cfg?: ReturnType<typeof loadConfig>;
  monitor?: ReturnType<typeof createOverseerMonitor>;
  hooks?: OverseerRunnerHooks;
}): Promise<OverseerTickResult> {
  const cfg = opts?.cfg ?? loadConfig();
  const resolved = resolveOverseerConfig(cfg);
  if (!resolved.enabled) return { status: "skipped", reason: "disabled" };
  if (!resolved.tickEveryMs) return { status: "skipped", reason: "disabled" };
  const queueSize = getQueueSize(CommandLane.Main);
  if (queueSize > 0) {
    return { status: "skipped", reason: "requests-in-flight" };
  }
  const now = Date.now();
  const monitor = opts?.monitor ?? createOverseerMonitor();
  try {
    const storeSnapshot = loadOverseerStoreFromDisk(cfg);
    const assignments = Object.values(storeSnapshot.assignments ?? {}).filter((assignment) =>
      isAssignmentAllowed(resolved, assignment),
    );
    const sampleFor = new Set<string>();
    for (const assignment of assignments) {
      if (assignment.status === "stalled" || assignment.status === "dispatched") {
        sampleFor.add(assignment.assignmentId);
      }
    }
    const telemetry = await monitor.collectTelemetry({
      assignments,
      sampleForAssignmentIds: sampleFor,
    });

    const outcome = await updateOverseerStore(async (store) => {
      const applied = reconcileOverseerState({
        store,
        telemetry,
        cfg: resolved,
        now,
      });
      await maybeApplyPlanner(store, now);
      return {
        store,
        result: applied,
      };
    }, cfg);

    // Invoke status transition hooks
    const hooks = opts?.hooks;
    if (hooks && outcome.statusTransitions) {
      for (const transition of outcome.statusTransitions) {
        try {
          if (transition.to === "stalled" && hooks.onAssignmentStalled) {
            hooks.onAssignmentStalled(transition.assignment);
          } else if (transition.to === "active" && hooks.onAssignmentActive) {
            hooks.onAssignmentActive(transition.assignment);
          } else if (transition.to === "done" && hooks.onAssignmentDone) {
            hooks.onAssignmentDone(transition.assignment);
          }
        } catch (err) {
          log.error("hook invocation failed", { hook: `on${transition.to}`, error: String(err) });
        }
      }
    }

    if (!outcome.didWork) {
      hooks?.onTickComplete?.({ didWork: false, actionCount: 0 });
      return { status: "ran", didWork: false };
    }

    let actions = outcome.actions;
    if (actions.length === 0) {
      hooks?.onTickComplete?.({ didWork: false, actionCount: 0 });
      return { status: "ran", didWork: false };
    }

    // Allow hooks to modify or filter actions before dispatch
    if (hooks?.onBeforeDispatch) {
      const modified = hooks.onBeforeDispatch(actions);
      if (modified) actions = modified;
    }

    const outcomes = await executeOverseerActions({ actions });
    if (outcomes.length === 0) {
      hooks?.onTickComplete?.({ didWork: false, actionCount: 0 });
      return { status: "ran", didWork: false };
    }
    await updateOverseerStore(async (store) => {
      for (const outcomeEntry of outcomes) {
        const assignment = store.assignments[outcomeEntry.assignmentId];
        if (!assignment) continue;
        const history = assignment.dispatchHistory;
        const entry = history.find((rec) => rec.dispatchId === outcomeEntry.dispatchId);
        if (entry) {
          entry.result = outcomeEntry.status;
          if (outcomeEntry.runId) entry.runId = outcomeEntry.runId;
          if (outcomeEntry.notes) entry.notes = outcomeEntry.notes;
        }
        if (outcomeEntry.runId) {
          assignment.runId = outcomeEntry.runId;
        }
        assignment.updatedAt = now;
        appendOverseerEvent(store, {
          ts: now,
          type: "assignment.dispatch.result",
          goalId: assignment.goalId,
          assignmentId: assignment.assignmentId,
          workNodeId: assignment.workNodeId,
          data: { status: outcomeEntry.status },
        });
      }
      return { store, result: true };
    }, cfg);
    hooks?.onTickComplete?.({ didWork: true, actionCount: actions.length });
    return { status: "ran", didWork: true };
  } catch (err) {
    log.error("overseer tick failed", { error: String(err) });
    return { status: "failed", reason: String(err) };
  } finally {
    if (!opts?.monitor) monitor.stop();
  }
}

export function startOverseerRunner(opts?: {
  cfg?: ReturnType<typeof loadConfig>;
  abortSignal?: AbortSignal;
  hooks?: OverseerRunnerHooks;
}): OverseerRunner {
  let cfg = opts?.cfg ?? loadConfig();
  let resolved = resolveOverseerConfig(cfg);
  let hooks = opts?.hooks ?? {};
  const monitor = createOverseerMonitor();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    setOverseerWakeHandler(null);
    monitor.stop();
  };

  const tickNow = async (params?: { reason?: string }) => {
    const res = await runOverseerTick({ reason: params?.reason, cfg, monitor, hooks });
    return { ok: res.status === "ran", didWork: res.status === "ran" && res.didWork };
  };

  const startInterval = () => {
    if (!resolved.enabled || !resolved.tickEveryMs) {
      if (timer) clearInterval(timer);
      timer = null;
      return;
    }
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      requestOverseerNow({ reason: "periodic" });
    }, resolved.tickEveryMs);
    timer.unref?.();
  };

  setOverseerWakeHandler(async ({ reason }) => {
    if (stopped) return { status: "skipped", reason: "stopped" };
    return await runOverseerTick({ reason, cfg, monitor, hooks });
  });

  startInterval();

  if (opts?.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => stop(), { once: true });
  }

  return {
    stop,
    updateConfig: (next) => {
      cfg = next;
      resolved = resolveOverseerConfig(cfg);
      startInterval();
    },
    tickNow,
    updateHooks: (newHooks) => {
      hooks = { ...hooks, ...newHooks };
    },
  };
}
