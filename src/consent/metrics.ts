/**
 * ConsentGate metrics: in-process counters for observability.
 * Snapshot can be read by a metrics endpoint or logger.
 */

export type ConsentMetricsSnapshot = {
  issues: number;
  consumes: number;
  revokes: number;
  denialsByReason: Record<string, number>;
  quarantine: number;
  failClosed: number;
};

export type ConsentMetrics = {
  incrementIssue(): void;
  incrementConsume(): void;
  incrementRevoke(): void;
  incrementDeny(reasonCode: string): void;
  incrementQuarantine(): void;
  incrementFailClosed(): void;
  getSnapshot(): ConsentMetricsSnapshot;
};

export function createConsentMetrics(): ConsentMetrics {
  let issues = 0;
  let consumes = 0;
  let revokes = 0;
  const denialsByReason: Record<string, number> = {};
  let quarantine = 0;
  let failClosed = 0;

  function incDeny(reasonCode: string): void {
    denialsByReason[reasonCode] = (denialsByReason[reasonCode] ?? 0) + 1;
  }

  return {
    incrementIssue() {
      issues += 1;
    },
    incrementConsume() {
      consumes += 1;
    },
    incrementRevoke() {
      revokes += 1;
    },
    incrementDeny(reasonCode: string) {
      incDeny(reasonCode);
    },
    incrementQuarantine() {
      quarantine += 1;
    },
    incrementFailClosed() {
      failClosed += 1;
    },
    getSnapshot(): ConsentMetricsSnapshot {
      return {
        issues,
        consumes,
        revokes,
        denialsByReason: { ...denialsByReason },
        quarantine,
        failClosed,
      };
    },
  };
}

/** No-op metrics when ConsentGate is disabled or observe-only without metrics. */
export function createNoOpConsentMetrics(): ConsentMetrics {
  const empty: ConsentMetricsSnapshot = {
    issues: 0,
    consumes: 0,
    revokes: 0,
    denialsByReason: {},
    quarantine: 0,
    failClosed: 0,
  };
  return {
    incrementIssue() {},
    incrementConsume() {},
    incrementRevoke() {},
    incrementDeny() {},
    incrementQuarantine() {},
    incrementFailClosed() {},
    getSnapshot: () => ({ ...empty, denialsByReason: {} }),
  };
}
