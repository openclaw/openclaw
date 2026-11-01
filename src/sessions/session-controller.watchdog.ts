import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { createAbortError } from "../infra/abort-signal.js";
import {
  createWatchdogAssessment,
  type WatchdogAssessmentBackend,
} from "./session-controller.watchdog-assessment.js";
import {
  decideSessionWatchdog,
  SESSION_WATCHDOG_ABORT_FLOOR_MS,
  SESSION_WATCHDOG_CLEANUP_MS,
  SESSION_WATCHDOG_QUIET_TOOL_MS,
  SESSION_WATCHDOG_WARNING_MS,
  type SessionWatchdogDecision,
  type SessionWatchdogPhase,
  type SessionWatchdogSnapshot,
  type SessionWatchdogWaitKind,
} from "./session-controller.watchdog-state.js";

type SessionWatchdogProgress = "semantic" | "transport" | "source_arrival" | "finalization";
type OwnedWait = {
  kind: SessionWatchdogWaitKind;
  deadlineAtMs?: number;
  rateLimitStopMessage?: string;
  isCurrent: () => boolean;
};
type OwnedExecution = {
  deadlineAtMs?: number;
  getDeadlineAtMs?: () => number | undefined;
  recoverDeadline?: () => Promise<boolean>;
};
const executionDeadline = (execution: OwnedExecution) =>
  execution.getDeadlineAtMs ? execution.getDeadlineAtMs() : execution.deadlineAtMs;
export type SessionWatchdogWait = {
  close(): void;
  updateDeadline(deadlineAtMs: number): void;
};
export type SessionControllerWatchdogAttempt = {
  isCurrent(): boolean;
  progress(kind: SessionWatchdogProgress, reason?: string): boolean;
  progressModel(reason?: string): boolean;
  observeStagnation(params: { active: boolean; existingOnly?: boolean }): void;
  progressTool(toolCallId: string, allowedNames: readonly string[]): boolean;
  beginWait(wait: OwnedWait): SessionWatchdogWait;
  beginTool(tool: {
    toolCallId: string;
    toolName: string;
    deadlineAtMs?: number;
  }): (completed?: boolean) => void;
  toolEvent(event: {
    phase: "start" | "end";
    toolCallId: string;
    toolName: string;
    deadlineAtMs?: number;
  }): void;
  beginRequest(params: {
    deadlineAtMs?: number;
    requestTimeoutMs?: number;
  }): (recoveryDeadlineAtMs?: number) => void;
  requestEvent(event: { phase: "start" | "end"; callId: string; requestTimeoutMs?: number }): void;
  setExecutionDeadline(deadlineAtMs: number | undefined): void;
  close(): void;
};
export type SessionWatchdogEffect = {
  cause: "run_stalled";
  reason: string;
  attempt?: SessionControllerWatchdogAttempt;
  /** Revalidate at each actual asynchronous stop/cleanup side effect. */
  isCurrent(): boolean;
  recoverExecutionDeadline?: () => Promise<boolean>;
};
export type SessionWatchdogEffectResult = "settled" | "blocked" | "resumed" | "model_recovery";
export type SessionControllerWatchdog = {
  start(): void;
  close(): void;
  snapshot(now?: number): SessionWatchdogSnapshot;
  decide(now?: number): SessionWatchdogDecision;
  tick(now?: number): Promise<SessionWatchdogDecision>;
  progress(kind: SessionWatchdogProgress, reason?: string): boolean;
  beginWait(wait: OwnedWait): SessionWatchdogWait;
  attachAttempt(params: { assertCurrent: () => void }): SessionControllerWatchdogAttempt;
  describeStop(): { staleReason: "no_activity" | "rate_limited"; error: Error };
  beginFinalization(): void;
  beginTerminal(deadlineAtMs?: number): void;
  beginExecution(
    getDeadlineAtMs?: () => number | undefined,
    recoverDeadline?: () => Promise<boolean>,
  ): {
    setDeadline(deadlineAtMs: number | undefined): void;
    close(): void;
  };
  beginFinalizationWork(timeoutMs: number): () => void;
};

const inertWait: SessionWatchdogWait = { close() {}, updateDeadline() {} };
const noop = () => {};
function live(assertion: () => boolean): boolean {
  try {
    return assertion();
  } catch {
    return false;
  }
}

/** State and timer belong to one exact operation; there is no recovery registry. */
export function createSessionControllerWatchdog(params: {
  startedAtMs: number;
  isCurrent: () => boolean;
  readPhase: () => SessionWatchdogPhase;
  readBackend?: () => WatchdogAssessmentBackend | undefined;
  requestStop: (
    effect: SessionWatchdogEffect,
  ) => SessionWatchdogEffectResult | Promise<SessionWatchdogEffectResult>;
  expireCleanup: (
    effect: SessionWatchdogEffect,
  ) => SessionWatchdogEffectResult | Promise<SessionWatchdogEffectResult>;
  onWarning?: (decision: SessionWatchdogDecision) => void;
}): SessionControllerWatchdog {
  const now = Date.now;
  const abortMs = Math.max(SESSION_WATCHDOG_ABORT_FLOOR_MS, 3 * SESSION_WATCHDOG_WARNING_MS);
  let closed = false;
  let semanticAt = params.startedAtMs;
  let transportAt = params.startedAtMs;
  let reason: string | undefined;
  let semanticSequence = 0;
  let stagnation:
    | { startedAtMs: number; observedAtMs: number; semanticSequence: number }
    | undefined;
  const stagnationCurrent = (at: number) =>
    stagnation &&
    !(semanticSequence > stagnation.semanticSequence && at - stagnation.observedAtMs >= 60_000);
  const progressOrigin = (at: number) =>
    stagnationCurrent(at) ? stagnation!.startedAtMs : semanticAt;
  let retryAllowanceAt: number | undefined;
  let requestRecoveryAt: number | undefined;
  let cleanupAt: number | undefined;
  let executionAt: number | undefined;
  let attempt: SessionControllerWatchdogAttempt | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let warningAt: number | undefined;
  let blockedWarning = false;
  let recovery: SessionWatchdogSnapshot["recovery"];
  let recoveryAction: "stop" | "expire_cleanup" | undefined;
  let pendingTick:
    | { decision: SessionWatchdogDecision; resolve: (decision: SessionWatchdogDecision) => void }
    | undefined;
  const requests = new Set<{ requestTimeoutMs?: number; deadlineAtMs?: number }>();
  const waits = new Set<OwnedWait>();
  const tools = new Set<SessionWatchdogSnapshot["tools"][number] & { touch(): void }>();
  const executions = new Set<OwnedExecution>();
  const finalizationWork = new Set<{ deadlineAtMs: number }>();
  const current = () => !closed && live(params.isCurrent);
  const semanticDeadline = (at = now()) =>
    Math.max(
      progressOrigin(at) + abortMs,
      requestRecoveryAt ?? 0,
      ...[...requests].map((request) => request.deadlineAtMs ?? 0),
    );

  const assessment = createWatchdogAssessment(
    () => ({
      current: current() && params.readPhase() === "active",
      attempt,
      backend: params.readBackend?.(),
      sequence: semanticSequence,
    }),
    () => {
      void tick().catch(() => {});
    },
  );

  const beginWait = (input: OwnedWait, valid = current): SessionWatchdogWait => {
    if (!valid()) {
      return inertWait;
    }
    // An approval deadline is supplied by the real approval owner, never invented here.
    if (
      (input.kind === "approval" || input.kind === "retry" || input.kind === "backend") &&
      !Number.isFinite(input.deadlineAtMs)
    ) {
      throw new Error("Owned bounded wait requires its deadline");
    }
    const wait: OwnedWait = { ...input, isCurrent: () => valid() && live(input.isCurrent) };
    if (wait.kind === "retry") {
      retryAllowanceAt ??= Math.max(semanticDeadline(), wait.deadlineAtMs!);
    }
    waits.add(wait);
    return {
      close() {
        waits.delete(wait);
      },
      updateDeadline(deadlineAtMs) {
        if (waits.has(wait) && wait.isCurrent() && Number.isFinite(deadlineAtMs)) {
          wait.deadlineAtMs = deadlineAtMs;
        }
      },
    };
  };
  const progress = (kind: SessionWatchdogProgress, nextReason?: string): boolean => {
    if (!current() || recovery) {
      return false;
    }
    if (kind === "source_arrival") {
      return true;
    }
    transportAt = now();
    if (kind === "semantic") {
      semanticAt = transportAt;
      semanticSequence += 1;
      assessment.clear();
      if (!stagnationCurrent(transportAt)) {
        retryAllowanceAt = undefined;
      }
      reason = nextReason;
      warningAt = undefined;
    } else if (kind === "finalization" && cleanupAt !== undefined) {
      cleanupAt = transportAt + SESSION_WATCHDOG_CLEANUP_MS;
      reason = nextReason;
    } else if (nextReason !== undefined) {
      reason = nextReason;
    }
    return true;
  };
  const snapshot = (at = now()): SessionWatchdogSnapshot => {
    const isCurrent = current();
    const liveWaits = [...waits]
      .filter((wait) => live(wait.isCurrent))
      .map((wait) => ({
        kind: wait.kind,
        // Mechanical traffic/retry rearming never moves the logical semantic horizon.
        deadlineAtMs:
          wait.kind === "backend"
            ? Math.min(wait.deadlineAtMs!, semanticDeadline(at))
            : wait.kind === "retry"
              ? Math.min(wait.deadlineAtMs!, retryAllowanceAt!)
              : wait.deadlineAtMs,
      }));
    const pendingAssessment = assessment.pendingWait();
    if (pendingAssessment) {
      liveWaits.push(pendingAssessment);
    }
    return {
      current: isCurrent && current(),
      phase: closed ? "settled" : params.readPhase(),
      hasActiveAttempt: attempt?.isCurrent() === true,
      semanticProgressAtMs: progressOrigin(at),
      lastProgressReason: stagnationCurrent(at) ? "tool_loop:argument_churn" : reason,
      warningMs: SESSION_WATCHDOG_WARNING_MS,
      semanticDeadlineAtMs: semanticDeadline(at),
      executionDeadlineAtMs: [executionAt, ...[...executions].map(executionDeadline)]
        .filter((deadline): deadline is number => deadline !== undefined)
        .reduce<number | undefined>(
          (earliest, deadline) =>
            earliest === undefined ? deadline : Math.min(earliest, deadline),
          undefined,
        ),
      cleanupDeadlineAtMs:
        cleanupAt === undefined
          ? undefined
          : Math.max(cleanupAt, ...[...finalizationWork].map((work) => work.deadlineAtMs)),
      waits: liveWaits,
      requests: requests.size
        ? [...requests].map(({ requestTimeoutMs, deadlineAtMs }) => ({
            requestTimeoutMs,
            deadlineAtMs,
          }))
        : undefined,
      tools: [...tools].map(
        ({ toolName, toolCallId, startedAtMs, explicitDeadlineAtMs, deadlineAtMs }) => ({
          toolName,
          toolCallId,
          startedAtMs,
          explicitDeadlineAtMs,
          deadlineAtMs,
        }),
      ),
      recovery: recovery && { ...recovery },
    };
  };
  const decide = (at = now()) => decideSessionWatchdog(snapshot(at), at);
  const tick = async (at = now()): Promise<SessionWatchdogDecision> => {
    assessment.check(at);
    const cleanupDeadlineAtMs = snapshot(at).cleanupDeadlineAtMs;
    const phase = params.readPhase();
    if (
      recovery?.status === "blocked" &&
      recoveryAction === "stop" &&
      (phase === "finishing" || phase === "terminal") &&
      cleanupDeadlineAtMs !== undefined &&
      at >= cleanupDeadlineAtMs
    ) {
      recovery = undefined;
      recoveryAction = undefined;
      blockedWarning = false;
    }
    const decision = decide(at);
    if (decision.action === "warn" || decision.action === "blocked") {
      if (warningAt !== semanticAt || (decision.action === "blocked" && !blockedWarning)) {
        warningAt = semanticAt;
        if (decision.action === "blocked" && recovery) {
          blockedWarning = true;
          recovery.status = "blocked";
          pendingTick?.resolve(decision);
          pendingTick = undefined;
        }
        params.onWarning?.(decision);
      }
      return decision;
    }
    if (decision.action !== "stop" && decision.action !== "expire_cleanup") {
      return decision;
    }
    const targetAttempt = attempt;
    if (
      decision.reason === "semantic_stall" &&
      tools.size === 0 &&
      assessment.begin(at, snapshot(at).executionDeadlineAtMs)
    ) {
      return assessment.result() ? tick(at) : decide(at);
    }
    if (decision.reason !== "semantic_stall") {
      assessment.clear();
    }
    const assessed = assessment.captureCurrent();
    const matchingExecutions =
      decision.reason === "execution_deadline"
        ? [...executions].filter(
            (execution) => executionDeadline(execution) === decision.deadlineAtMs,
          )
        : [];
    // A lane mirrors its deadline onto the attempt; retain its recovery owner on ties.
    const targetExecution =
      matchingExecutions.find((execution) => execution.recoverDeadline) ?? matchingExecutions[0];
    const targetsAttemptExecution =
      decision.reason === "execution_deadline" &&
      !targetExecution &&
      executionAt === decision.deadlineAtMs;
    const recoverDeadline = targetExecution?.recoverDeadline;
    const effect: SessionWatchdogEffect = {
      cause: "run_stalled",
      reason: decision.reason,
      attempt: targetAttempt,
      isCurrent: () => {
        if (!current() || attempt !== targetAttempt || (assessed && !assessed())) {
          return false;
        }
        if (assessed) {
          const latest = decideSessionWatchdog({ ...snapshot(), recovery: undefined }, now());
          if (latest.action !== decision.action || latest.reason !== decision.reason) {
            return false;
          }
        }
        if (decision.reason !== "execution_deadline") {
          return true;
        }
        if (targetExecution && executions.has(targetExecution)) {
          const deadlineAtMs = executionDeadline(targetExecution);
          return deadlineAtMs !== undefined && now() >= deadlineAtMs;
        }
        return targetsAttemptExecution && executionAt !== undefined && now() >= executionAt;
      },
      recoverExecutionDeadline:
        targetExecution && recoverDeadline
          ? async () => {
              if (!effect.isCurrent()) {
                return false;
              }
              return await recoverDeadline();
            }
          : undefined,
    };
    if (!effect.isCurrent()) {
      return { action: "observe", reason: "retired" };
    }
    // Install before invoking an effect: cancellation can synchronously reenter tick.
    const ownedRecovery: NonNullable<SessionWatchdogSnapshot["recovery"]> = {
      status: "pending",
      startedAtMs: at,
    };
    recovery = ownedRecovery;
    recoveryAction = decision.action;
    let ownedPendingTick: typeof pendingTick;
    const deadlineResult = new Promise<SessionWatchdogDecision>((resolve) => {
      ownedPendingTick = { decision, resolve };
      pendingTick = ownedPendingTick;
    });
    const effectResult = (async (): Promise<SessionWatchdogDecision> => {
      try {
        const result = await (
          decision.action === "expire_cleanup" ? params.expireCleanup : params.requestStop
        )(effect);
        if (result === "resumed" || result === "model_recovery") {
          if (recovery === ownedRecovery && current()) {
            recovery = undefined;
            recoveryAction = undefined;
            if (!effect.isCurrent()) {
              assessment.clear();
            } else {
              assessment.check(now());
            }
            blockedWarning = false;
            const resumedPhase = params.readPhase();
            if (resumedPhase === "finishing" || resumedPhase === "terminal") {
              cleanupAt = now() + SESSION_WATCHDOG_CLEANUP_MS;
            }
            return {
              action: "observe",
              reason: result === "model_recovery" ? "model_recovery" : "owner_recovery",
            };
          }
          return { action: "observe", reason: "retired" };
        }
        // A committed Stop may close its attempt; recovery still belongs to this owner.
        if (
          recovery === ownedRecovery &&
          recovery.status !== "settled" &&
          (result === "settled" || current())
        ) {
          recovery.status = result;
        }
      } catch (error) {
        if (recovery === ownedRecovery && recovery.status !== "settled" && current()) {
          recovery.status = "blocked";
          recovery.error = String(error);
        }
      } finally {
        if (pendingTick === ownedPendingTick) {
          pendingTick = undefined;
        }
      }
      return recovery?.status === "blocked"
        ? { action: "blocked", reason: "cleanup_pending" }
        : decision;
    })();
    // The owner timer reports a hung cleanup as blocked; custody stays until real settlement.
    return Promise.race([effectResult, deadlineResult]);
  };
  const schedule = () => {
    if (!started || !current()) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      // Schedule independently of pending cleanup; a hung effect becomes visibly blocked.
      void tick().catch(() => {});
      schedule();
    }, 1_000);
    timer.unref?.();
  };
  const beginCleanup = () => {
    assessment.clear();
    if (current()) {
      cleanupAt ??= now() + SESSION_WATCHDOG_CLEANUP_MS;
    }
  };
  return {
    start() {
      if (!started && !closed) {
        started = true;
        schedule();
      }
    },
    close() {
      if (recovery && recovery.status !== "settled") {
        recovery.status = "settled";
      }
      pendingTick?.resolve(pendingTick.decision);
      pendingTick = undefined;
      closed = true;
      assessment.clear();
      recoveryAction = undefined;
      started = false;
      clearTimeout(timer);
      timer = undefined;
      waits.clear();
      tools.clear();
      requests.clear();
      finalizationWork.clear();
      executions.clear();
      attempt = undefined;
    },
    snapshot,
    decide,
    tick,
    progress,
    beginWait: (input) => beginWait(input),
    describeStop() {
      // A stop during a rate-limit backoff reports the limit, not a stall.
      const rateLimitMessage = [...waits].find(
        (wait) =>
          wait.kind === "retry" && wait.rateLimitStopMessage !== undefined && live(wait.isCurrent),
      )?.rateLimitStopMessage;
      const result = assessment.result();
      return {
        staleReason: rateLimitMessage === undefined ? "no_activity" : "rate_limited",
        error: Object.assign(
          createAbortError(
            rateLimitMessage ??
              (result?.state === "closed"
                ? "Reply backend closed before completing"
                : "Reply operation stalled"),
          ),
          {
            code: "OPENCLAW_SESSION_WATCHDOG",
            ...(result ? { assessment: result } : {}),
          },
        ),
      };
    },
    beginFinalization: beginCleanup,
    beginTerminal(deadlineAtMs) {
      beginCleanup();
      if (current() && deadlineAtMs !== undefined) {
        cleanupAt = Math.min(cleanupAt!, deadlineAtMs);
      }
    },
    beginExecution(getDeadlineAtMs, recoverDeadline) {
      const execution: OwnedExecution = {
        getDeadlineAtMs,
        recoverDeadline,
      };
      if (current()) {
        executions.add(execution);
      }
      return {
        setDeadline(deadlineAtMs) {
          if (current() && executions.has(execution)) {
            execution.deadlineAtMs = deadlineAtMs;
          }
        },
        close() {
          executions.delete(execution);
        },
      };
    },
    beginFinalizationWork(timeoutMs) {
      if (!current()) {
        return noop;
      }
      const work = {
        deadlineAtMs: now() + resolveTimerTimeoutMs(timeoutMs, SESSION_WATCHDOG_CLEANUP_MS, 1),
      };
      finalizationWork.add(work);
      return () => {
        finalizationWork.delete(work);
      };
    },
    attachAttempt({ assertCurrent }) {
      if (!current() || recovery) {
        throw new Error("Cannot attach attempt to retired or recovering operation");
      }
      const previousAttempt = attempt;
      assertCurrent();
      if (!current() || recovery || attempt !== previousAttempt) {
        throw new Error("Operation retired while attaching attempt");
      }
      previousAttempt?.close();
      let attemptClosed = false;
      const ownedReleases = new Set<() => void>();
      const emittedTools = new Map<string, (completed?: boolean) => void>();
      const emittedRequests = new Map<string, () => void>();
      const valid = () =>
        current() &&
        !attemptClosed &&
        attempt === next &&
        live(() => {
          assertCurrent();
          return true;
        }) &&
        current() &&
        !attemptClosed &&
        attempt === next;
      const next: SessionControllerWatchdogAttempt = {
        isCurrent: valid,
        progress: (kind, nextReason) => valid() && progress(kind, nextReason),
        progressModel: (nextReason) =>
          valid() && tools.size === 0 && progress("semantic", nextReason),
        progressTool(toolCallId, allowedNames) {
          if (!valid()) {
            return false;
          }
          for (const tool of tools) {
            if (tool.toolCallId === toolCallId && allowedNames.includes(tool.toolName)) {
              tool.touch();
              return progress("semantic", "tool:owned_progress");
            }
          }
          return false;
        },
        observeStagnation(observation) {
          if (!valid() || (observation.existingOnly && !stagnation)) {
            return;
          }
          if (!observation.active) {
            stagnation = undefined;
            return;
          }
          const at = now();
          const startedAtMs = stagnationCurrent(at) ? stagnation!.startedAtMs : at;
          stagnation = { startedAtMs, observedAtMs: at, semanticSequence };
        },
        beginWait(input) {
          const wait = beginWait(input, valid);
          const close = () => {
            wait.close();
            ownedReleases.delete(close);
          };
          ownedReleases.add(close);
          return { close, updateDeadline: (deadlineAtMs) => wait.updateDeadline(deadlineAtMs) };
        },
        beginTool(tool) {
          if (!valid()) {
            return noop;
          }
          const startedAtMs = now();
          let lastProgressAtMs = startedAtMs;
          const record = {
            toolName: tool.toolName,
            toolCallId: tool.toolCallId,
            startedAtMs,
            touch() {
              lastProgressAtMs = now();
            },
            get explicitDeadlineAtMs() {
              return tool.deadlineAtMs;
            },
            get deadlineAtMs() {
              return (tool.deadlineAtMs ?? lastProgressAtMs) + SESSION_WATCHDOG_QUIET_TOOL_MS;
            },
          };
          tools.add(record);
          const close = (completed = false) => {
            if (!tools.delete(record)) {
              return;
            }
            ownedReleases.delete(close);
            if (completed && valid()) {
              progress("semantic", "tool:completed");
            }
          };
          ownedReleases.add(close);
          return close;
        },
        toolEvent(event) {
          if (!valid()) {
            return;
          }
          if (event.phase === "start") {
            if (!emittedTools.has(event.toolCallId)) {
              emittedTools.set(event.toolCallId, next.beginTool(event));
            }
          } else {
            emittedTools.get(event.toolCallId)?.(true);
            emittedTools.delete(event.toolCallId);
          }
        },
        beginRequest(request) {
          if (!valid()) {
            return noop;
          }
          // Keep the request owner's live deadline rather than a start-time copy.
          requests.add(request);
          const close = (recoveryDeadlineAtMs?: number) => {
            if (!requests.delete(request)) {
              return;
            }
            if (recoveryDeadlineAtMs !== undefined) {
              requestRecoveryAt = Math.max(requestRecoveryAt ?? 0, recoveryDeadlineAtMs);
            }
            ownedReleases.delete(close);
          };
          ownedReleases.add(close);
          return close;
        },
        requestEvent(event) {
          if (event.phase === "start") {
            if (!valid() || emittedRequests.has(event.callId)) {
              return;
            }
            emittedRequests.set(
              event.callId,
              next.beginRequest({
                requestTimeoutMs: event.requestTimeoutMs,
                deadlineAtMs:
                  event.requestTimeoutMs === undefined ? undefined : now() + event.requestTimeoutMs,
              }),
            );
          } else {
            emittedRequests.get(event.callId)?.();
            emittedRequests.delete(event.callId);
          }
        },
        setExecutionDeadline(deadlineAtMs) {
          if (valid()) {
            executionAt = deadlineAtMs;
          }
        },
        close() {
          attemptClosed = true;
          for (const release of ownedReleases) {
            release();
          }
          emittedTools.clear();
          emittedRequests.clear();
          if (attempt === next) {
            assessment.clear();
            attempt = undefined;
            executionAt = undefined;
          }
        },
      };
      attempt = next;
      return next;
    },
  };
}
