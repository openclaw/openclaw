import { performance } from "node:perf_hooks";
import { createQueuedDiagnosticPhaseEmitter } from "../../infra/diagnostic-events.js";

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
type ChatSendPhase = (typeof PHASES)[number];
type PhaseScope = { mark: (phase?: ChatSendPhase) => void; finish: () => void };

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
  const totals = new Map<ChatSendPhase, number>();
  const active = new Set<(now: number) => void>();
  let stage: "request" | "startup" = "request";
  let startedAt = performance.now();
  let acknowledgedMs: number | undefined;
  let finished = false;

  const report = () => {
    const now = performance.now();
    for (const flush of active) {
      flush(now);
    }
    const elapsedMs = now - startedAt;
    const endedAt = Date.now();
    try {
      let message = `slow chat send ${Math.round(elapsedMs)}ms stage=${stage}`;
      if (acknowledgedMs !== undefined) {
        message += ` ack=${Math.round(acknowledgedMs)}ms`;
      }
      for (const phase of PHASES) {
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
        message += ` ${phase}=${Math.round(durationMs)}ms`;
      }
      if (elapsedMs >= 1_000) {
        log.info(message);
      }
    } catch {
      // Diagnostic failures must not change acknowledgement or dispatch outcomes.
    }
    totals.clear();
    startedAt = now;
    return elapsedMs;
  };

  const finish = () => {
    if (!finished) {
      report();
      finished = true;
      active.clear();
    }
  };
  return {
    scope(initialPhase: ChatSendPhase): PhaseScope | undefined {
      if (finished) {
        return undefined;
      }
      let phase: ChatSendPhase | undefined = initialPhase;
      let phaseStartedAt = performance.now();
      const flush = (now: number) => {
        if (phase) {
          totals.set(phase, (totals.get(phase) ?? 0) + now - phaseStartedAt);
        }
        phaseStartedAt = now;
      };
      active.add(flush);
      const scope: PhaseScope = {
        mark(nextPhase) {
          if (active.has(flush)) {
            flush(performance.now());
            phase = nextPhase;
          }
        },
        finish() {
          scope.mark();
          active.delete(flush);
        },
      };
      return scope;
    },
    acknowledge() {
      if (!finished && stage === "request") {
        acknowledgedMs = report();
        stage = "startup";
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
