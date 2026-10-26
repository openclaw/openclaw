import { AsyncContext } from "../shared/async-context.js";

/**
 * Fixed subphases of one coordinated write admission grant. A segment is attributed to the
 * boundary that closes it, so `release` covers everything after the final native settlement.
 */
type SqliteWritePhase = "lease-prepare" | "open" | "schema" | "mutation" | "commit" | "release";

export type SqliteWritePhaseEvent =
  | { kind: "phase"; phase: Exclude<SqliteWritePhase, "mutation" | "commit" | "release"> }
  | { kind: "transaction"; step: "begin" | "commit-start" | "commit-end" | "rollback" };

/** Monotonic, process-wide milliseconds: comparable between the parent and its Workers. */
export function sqliteWritePhaseClockMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

type SqliteWritePhaseSpan = {
  phase: SqliteWritePhase;
  startMs: number;
  endMs: number;
  /** Native transaction state while this segment ran; never SQL text or arguments. */
  nativeTransaction: boolean;
};

export type SqliteWritePhaseReport = {
  startMs: number;
  endMs: number;
  spans: SqliteWritePhaseSpan[];
  /** Spans beyond the bounded list still count toward `totalsMs`. */
  droppedSpans: number;
  totalsMs: Record<SqliteWritePhase, number>;
  nativeTransactionMs: number;
  nativeTransactions: number;
  nativeTransactionOpenAtEnd: boolean;
};

const MAX_REPORTED_SPANS = 32;

export type SqliteWritePhaseRecorder = {
  record(event: SqliteWritePhaseEvent): void;
  finish(): SqliteWritePhaseReport;
};

export function createSqliteWritePhaseRecorder(
  startMs = sqliteWritePhaseClockMs(),
  now: () => number = sqliteWritePhaseClockMs,
): SqliteWritePhaseRecorder {
  const spans: SqliteWritePhaseSpan[] = [];
  const totalsMs: Record<SqliteWritePhase, number> = {
    "lease-prepare": 0,
    open: 0,
    schema: 0,
    mutation: 0,
    commit: 0,
    release: 0,
  };
  let droppedSpans = 0;
  let segmentStartMs = startMs;
  let transactionStartMs: number | undefined;
  let nativeTransactionMs = 0;
  let nativeTransactions = 0;
  let finished: SqliteWritePhaseReport | undefined;
  const close = (phase: SqliteWritePhase) => {
    const endMs = Math.max(now(), segmentStartMs);
    totalsMs[phase] += endMs - segmentStartMs;
    const previous = spans.at(-1);
    const nativeTransaction = transactionStartMs !== undefined;
    if (
      previous?.phase === phase &&
      previous.nativeTransaction === nativeTransaction &&
      previous.endMs === segmentStartMs
    ) {
      previous.endMs = endMs;
    } else if (spans.length < MAX_REPORTED_SPANS) {
      spans.push({ phase, startMs: segmentStartMs, endMs, nativeTransaction });
    } else {
      droppedSpans += 1;
    }
    segmentStartMs = endMs;
    return endMs;
  };
  return {
    record(event) {
      if (finished) {
        return;
      }
      if (event.kind === "phase") {
        close(event.phase);
        return;
      }
      switch (event.step) {
        case "begin":
          // BEGIN IMMEDIATE wait and pre-transaction reads belong to the mutation owner.
          transactionStartMs = close("mutation");
          nativeTransactions += 1;
          return;
        case "commit-start":
          close("mutation");
          return;
        case "commit-end":
        case "rollback": {
          const endMs = close(event.step === "commit-end" ? "commit" : "mutation");
          if (transactionStartMs !== undefined) {
            nativeTransactionMs += endMs - transactionStartMs;
          }
          transactionStartMs = undefined;
        }
      }
    },
    finish() {
      if (finished) {
        return finished;
      }
      const endMs = close("release");
      finished = {
        startMs,
        endMs,
        spans,
        droppedSpans,
        totalsMs,
        nativeTransactionMs,
        nativeTransactions,
        nativeTransactionOpenAtEnd: transactionStartMs !== undefined,
      };
      return finished;
    },
  };
}

const roundMs = (value: number) => Math.round(value * 1_000) / 1_000;

/**
 * Bounded log fields for one grant. `release` extends from the Worker's final boundary to the
 * owner's observed release, so phase totals partition the grant's whole writer hold.
 */
export function sqliteWritePhaseLogFields(params: {
  report: SqliteWritePhaseReport;
  grantedAtMs?: number;
  releasedAtMs?: number;
}) {
  const { report } = params;
  const releaseEndMs = Math.max(params.releasedAtMs ?? report.endMs, report.endMs);
  const totals = report.totalsMs;
  const phasesMs: Record<SqliteWritePhase, number> = {
    "lease-prepare": roundMs(totals["lease-prepare"]),
    open: roundMs(totals.open),
    schema: roundMs(totals.schema),
    mutation: roundMs(totals.mutation),
    commit: roundMs(totals.commit),
    release: roundMs(totals.release + releaseEndMs - report.endMs),
  };
  return {
    phasesMs,
    ...(params.grantedAtMs !== undefined
      ? { grantTransitMs: roundMs(Math.max(0, report.startMs - params.grantedAtMs)) }
      : {}),
    nativeTransactionMs: roundMs(report.nativeTransactionMs),
    nativeTransactions: report.nativeTransactions,
    nativeTransactionOpenAtRelease: report.nativeTransactionOpenAtEnd,
    spans: report.spans.map((span, index) => ({
      phase: span.phase,
      startMs: roundMs(span.startMs),
      endMs: roundMs(
        index === report.spans.length - 1 && span.phase === "release" ? releaseEndMs : span.endMs,
      ),
      nativeTransaction: span.nativeTransaction,
    })),
    ...(report.droppedSpans > 0 ? { droppedSpans: report.droppedSpans } : {}),
  };
}

const observers = new AsyncContext<SqliteWritePhaseRecorder>(
  Symbol.for("openclaw.sqliteWritePhaseObserver"),
);

/** Scope one admission grant; nested native work reports to the innermost grant only. */
export function withSqliteWritePhaseObserver<T>(
  recorder: SqliteWritePhaseRecorder,
  run: () => T,
): T {
  return observers.run(recorder, run);
}

/** Diagnostics only: an observer failure can never change a native write outcome. */
export function recordSqliteWritePhase(event: SqliteWritePhaseEvent): void {
  try {
    observers.getStore()?.record(event);
  } catch {
    // Timing observations are best effort.
  }
}
