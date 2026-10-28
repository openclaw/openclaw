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
  let finished = false;

  const report = () => {
    const now = performance.now();
    timing.flush(now);
    const elapsedMs = now - startedAt;
    const slow = elapsedMs >= 1_000;
    if (!slow && !emit) {
      totals.clear();
      startedAt = now;
      return elapsedMs;
    }
    const endedAt = emit ? Date.now() : 0;
    try {
      let message = slow ? `slow chat send ${Math.round(elapsedMs)}ms stage=${stage}` : "";
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
          details: { stage },
        });
        if (slow) {
          message += ` ${phase}=${Math.round(durationMs)}ms`;
        }
      }
      if (slow) {
        log.info(message);
      }
    } catch {
      // Diagnostic failures must not change acknowledgement or dispatch outcomes.
    }
    totals.clear();
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
      const phase = `detail.${spanName}` as const;
      if (durationMs !== undefined) {
        totals.set(phase, (totals.get(phase) ?? 0) + durationMs);
        return undefined;
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
