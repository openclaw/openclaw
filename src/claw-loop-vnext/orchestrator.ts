import { randomUUID } from "node:crypto";
import path from "node:path";
import type { LoopTransport } from "./transport/types.js";
import type { GoalFile, Signal } from "./types.js";
import { appendEvent, createEvent } from "./event-log.js";
import {
  buildPhasePrompt,
  ensureApprovalGate,
  getCurrentPhase,
  loadGoalFile,
  saveGoalFile,
  updatePhaseStatus,
} from "./goal.js";
import { RuntimeStore } from "./runtime-store.js";
import { extractSignals } from "./signal-parser.js";
import { sendWithRetry } from "./transport/send-with-retry.js";

export type OrchestratorDeps = {
  primaryTransport: LoopTransport;
  fallbackTransport?: LoopTransport;
  goalsDir: string;
};

export type HandleResult = {
  goal: GoalFile;
  delivered: boolean;
  transport: string;
  ackId?: string;
  signals: Signal[];
  outputText: string;
};

export type StuckTickResult = {
  nudged: boolean;
  reason: "sent" | "within_cooldown" | "below_threshold" | "no_pending_phase";
};

function goalIdFromFile(goalFile: string): string {
  return path.basename(goalFile, ".json");
}

function runtimePaths(goalsDir: string, goalId: string) {
  return {
    eventLogFile: path.join(goalsDir, ".runtime", `${goalId}.events.jsonl`),
    stateFile: path.join(goalsDir, ".runtime", `${goalId}.state.json`),
  };
}

async function processSignals(params: {
  goal: GoalFile;
  goalFile: string;
  goalId: string;
  signals: Signal[];
  store: RuntimeStore;
  eventLogFile: string;
}): Promise<GoalFile> {
  let goal = params.goal;

  for (const signal of params.signals) {
    const seen = await params.store.hasSeenSignal(params.goalId, signal.dedupeKey);
    if (seen) {
      await appendEvent(
        params.eventLogFile,
        createEvent(params.goalId, "signal_deduped", {
          dedupeKey: signal.dedupeKey,
          type: signal.type,
        }),
      );
      continue;
    }

    await params.store.markSignalSeen(params.goalId, signal.dedupeKey);
    await appendEvent(
      params.eventLogFile,
      createEvent(params.goalId, "signal_seen", { dedupeKey: signal.dedupeKey, type: signal.type }),
    );

    if (signal.type === "phase_complete") {
      goal = updatePhaseStatus(goal, signal.phaseId, "complete");
      goal = ensureApprovalGate(goal, signal.phaseId);
      await appendEvent(
        params.eventLogFile,
        createEvent(params.goalId, "phase_advanced", {
          phaseId: signal.phaseId,
          status: "complete",
        }),
      );
      continue;
    }

    if (signal.type === "phase_blocked") {
      const current = getCurrentPhase(goal);
      if (current) {
        goal = updatePhaseStatus(goal, current.id, "blocked");
      }
      goal.status = "blocked";
      continue;
    }

    if (signal.type === "goal_complete" || signal.type === "promise_done") {
      goal.status = "complete";
    }
  }

  await saveGoalFile(params.goalFile, goal);
  return goal;
}

export async function sendCurrentPhasePrompt(
  deps: OrchestratorDeps,
  goalFile: string,
  messageOverride?: string,
): Promise<HandleResult> {
  const goalId = goalIdFromFile(goalFile);
  const goal = await loadGoalFile(goalFile);
  const { eventLogFile, stateFile } = runtimePaths(deps.goalsDir, goalId);
  const store = new RuntimeStore(stateFile);

  const current = getCurrentPhase(goal);
  const message = messageOverride ?? (current ? buildPhasePrompt(goal, current) : "");
  if (!message.trim()) {
    return {
      goal,
      delivered: false,
      transport: deps.primaryTransport.kind,
      signals: [],
      outputText: "",
    };
  }

  const idempotencyKey = randomUUID();
  const ackTimeoutMs = goal.orchestration?.ackTimeoutMs ?? 15_000;
  const maxRetries = goal.orchestration?.maxRetries ?? 2;

  const sendResult = await sendWithRetry({
    primary: deps.primaryTransport,
    fallback: deps.fallbackTransport,
    request: {
      goalId,
      workdir: goal.workdir,
      message,
      idempotencyKey,
      ackTimeoutMs,
      sessionName: goal.session,
    },
    maxRetries,
    onEvent: async (event) => appendEvent(eventLogFile, event),
  });

  await store.recordDelivery(goalId, idempotencyKey, sendResult.delivered, sendResult.transport);
  await appendEvent(
    eventLogFile,
    createEvent(goalId, "goal_updated", {
      delivery: sendResult.delivered,
      transport: sendResult.transport,
      ackId: sendResult.ackId,
    }),
  );

  const signals = extractSignals(sendResult.outputText);
  const nextGoal = await processSignals({
    goal,
    goalFile,
    goalId,
    signals,
    store,
    eventLogFile,
  });

  return {
    goal: nextGoal,
    delivered: sendResult.delivered,
    transport: sendResult.transport,
    ackId: sendResult.ackId,
    signals,
    outputText: sendResult.outputText,
  };
}

export async function approveNextPhase(goalFile: string): Promise<GoalFile> {
  const goal = await loadGoalFile(goalFile);
  return {
    ...goal,
    awaitingApproval: undefined,
  };
}

export async function nudgeIfStuck(
  deps: OrchestratorDeps,
  goalFile: string,
  options?: { stuckAfterMs?: number; cooldownMs?: number },
): Promise<StuckTickResult> {
  const goalId = goalIdFromFile(goalFile);
  const goal = await loadGoalFile(goalFile);
  const current = getCurrentPhase(goal);
  if (!current) {
    return { nudged: false, reason: "no_pending_phase" };
  }

  const { eventLogFile, stateFile } = runtimePaths(deps.goalsDir, goalId);
  const store = new RuntimeStore(stateFile);
  const now = Date.now();
  const stuckAfterMs = options?.stuckAfterMs ?? 5 * 60_000;
  const cooldownMs = options?.cooldownMs ?? 10 * 60_000;
  const lastNudgeAt = await store.getLastNudgeAt(goalId);
  if (lastNudgeAt && now - Date.parse(lastNudgeAt) < cooldownMs) {
    await appendEvent(
      eventLogFile,
      createEvent(goalId, "stuck_nudge_skipped", { reason: "within_cooldown", lastNudgeAt }),
    );
    return { nudged: false, reason: "within_cooldown" };
  }

  const lastActivityAt = await store.getLastActivityAt(goalId);
  if (!lastActivityAt || now - Date.parse(lastActivityAt) < stuckAfterMs) {
    await appendEvent(
      eventLogFile,
      createEvent(goalId, "stuck_nudge_skipped", { reason: "below_threshold", lastActivityAt }),
    );
    return { nudged: false, reason: "below_threshold" };
  }

  const message =
    "# Orchestrator Nudge\n\nPlease post a concise progress update for the current phase. Continue execution, and only emit PHASE_COMPLETE when done.";
  const result = await sendCurrentPhasePrompt(deps, goalFile, message);
  if (result.delivered) {
    await store.markNudgeSent(goalId);
    await appendEvent(
      eventLogFile,
      createEvent(goalId, "stuck_nudge_sent", {
        transport: result.transport,
        ackId: result.ackId,
      }),
    );
    return { nudged: true, reason: "sent" };
  }

  await appendEvent(
    eventLogFile,
    createEvent(goalId, "stuck_nudge_skipped", { reason: "below_threshold", delivery: false }),
  );
  return { nudged: false, reason: "below_threshold" };
}
