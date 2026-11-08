import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";
import { createPhaseTimings } from "./phase-timings.js";

const PHASES = [
  "authority",
  "admission",
  "preparation",
  "attachments",
  "replyContext",
  "authoring",
  "persist",
  "runAdmission",
  "replyInitialization",
  "snapshot",
  "worktree",
  "effects",
  "response",
  "dispatch",
] as const;
type ChatSendPhase = (typeof PHASES)[number] | `detail.${string}`;
type PostAckStage = "startup" | "steer" | "queued";
const DEPENDENCY_RETIRE_VERIFY =
  "attempt.setup.sandbox.workspace_selection.prepare.reconcile.dependency.retire.verify";

export type ChatSendDiagnostics = ReturnType<typeof startChatSendDiagnostics>;

const requestDiagnostics = new WeakMap<object, ChatSendDiagnostics>();

/** Internal request attachment; handler spans do not expand the public plugin options. */
export function bindChatSendDiagnostics(
  request: object,
  diagnostics: ChatSendDiagnostics | undefined,
) {
  if (diagnostics) {
    requestDiagnostics.set(request, diagnostics);
  }
}

export function readChatSendDiagnostics(request: object): ChatSendDiagnostics | undefined {
  return requestDiagnostics.get(request);
}

/** Request-owned totals; nested and parallel phases can overlap. */
export function startChatSendDiagnostics(log: { info(message: string): void }) {
  const emit = createQueuedDiagnosticPhaseEmitter();
  const timing = createPhaseTimings<ChatSendPhase>();
  const { totals } = timing;
  let stage: "request" | PostAckStage = "request";
  let startedAt = performance.now();
  let acknowledgedMs: number | undefined;
  let dependencyRetireVerifyAttempts = 0;
  let laneWait: string | undefined;
  let finished = false;
  let identity: { sessionId: string; runId: string } | undefined;

  const report = () => {
    const now = performance.now();
    timing.flush(now);
    const elapsedMs = now - startedAt;
    const slow = elapsedMs >= 1_000;
    if (!slow && !emit) {
      totals.clear();
      dependencyRetireVerifyAttempts = 0;
      laneWait = undefined;
      startedAt = now;
      return elapsedMs;
    }
    const endedAt = emit ? Date.now() : 0;
    try {
      let message = slow ? `slow chat send ${Math.round(elapsedMs)}ms stage=${stage}` : "";
      if (slow && identity) {
        message += ` sessionId=${identity.sessionId} runId=${identity.runId}`;
      }
      if (slow && acknowledgedMs !== undefined) {
        message += ` ack=${Math.round(acknowledgedMs)}ms`;
      }
      for (const phase of [
        ...PHASES,
        ...[...totals.keys()].filter((name) => name.startsWith("detail.")).toSorted(),
      ]) {
        const durationMs = totals.get(phase);
        if (durationMs === undefined) {
          continue;
        }
        emit?.({
          name: `chat.send.${phase}`,
          startedAt: endedAt - elapsedMs,
          endedAt,
          durationMs,
          details: { stage, ...identity },
        });
        if (slow) {
          message += ` ${phase}=${Math.round(durationMs)}ms`;
        }
      }
      if (slow) {
        if (dependencyRetireVerifyAttempts) {
          message += ` detail.${DEPENDENCY_RETIRE_VERIFY}.attempts=${dependencyRetireVerifyAttempts}`;
        }
        if (laneWait) {
          message += ` laneWait=${laneWait}`;
        }
        log.info(message);
      }
    } catch {
      // Diagnostic failures must not change acknowledgement or dispatch outcomes.
    }
    totals.clear();
    dependencyRetireVerifyAttempts = 0;
    laneWait = undefined;
    startedAt = now;
    return elapsedMs;
  };

  const finish = (disposition?: {
    isSteered(): boolean;
    isEnqueued(): boolean;
    isTerminal(): boolean;
  }) => {
    if (!finished) {
      if (disposition?.isSteered()) {
        stage = "steer";
      } else if (disposition?.isEnqueued() || disposition?.isTerminal()) {
        stage = "queued";
      }
      report();
      finished = true;
      timing.close();
    }
  };
  const scope = (phase: ChatSendPhase) => (finished ? undefined : timing.scope(phase));
  return {
    setRunIdentity(sessionId: string, runId: string) {
      identity = { sessionId, runId };
    },
    scope,
    observeSpan: (
      name: string,
      attributes: Record<string, unknown> | undefined,
      durationMs?: number,
    ) => {
      const spanName = name === "agent.prepare" ? attributes?.stage : name;
      if (typeof spanName !== "string" || finished) {
        return undefined;
      }
      if (spanName === "command_lane.wait" && typeof attributes?.wait === "string") {
        laneWait = attributes.wait;
      }
      const phase = `detail.${spanName}` as const;
      if (durationMs !== undefined) {
        totals.set(phase, (totals.get(phase) ?? 0) + durationMs);
        return undefined;
      }
      if (spanName === DEPENDENCY_RETIRE_VERIFY) {
        dependencyRetireVerifyAttempts++;
      }
      return scope(phase)?.finish;
    },
    acknowledge(disposition: PostAckStage = "startup") {
      if (!finished && stage === "request") {
        acknowledgedMs = report();
        stage = disposition;
      }
    },
    finish,
    [Symbol.dispose]() {
      if (stage === "request") {
        finish();
      }
    },
  };
}
