import "./status-footer.js";

type StatusFooterTestApi = {
  finalizeStatusFooterRun(runId: string): Promise<void>;
  noteStatusFooterRunStarted(runId: string, startedAt: number): void;
  resetStatusFooterStateForTest(): void;
};

function getTestApi(): StatusFooterTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.statusFooterTestApi")
  ];
  if (!api) {
    throw new Error("status footer test API is unavailable");
  }
  return api as StatusFooterTestApi;
}

export function finalizeStatusFooterRun(runId: string): Promise<void> {
  return getTestApi().finalizeStatusFooterRun(runId);
}

export function noteStatusFooterRunStarted(runId: string, startedAt: number): void {
  getTestApi().noteStatusFooterRunStarted(runId, startedAt);
}

export function resetStatusFooterStateForTest(): void {
  getTestApi().resetStatusFooterStateForTest();
}
