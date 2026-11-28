/** Distinguishes an enclosing execution span from its preparation work. */
export type StageTimingKind = "execution";

/** One recorded duration and its elapsed time relative to tracker creation. */
export type StageTiming = {
  name: string;
  durationMs: number;
  elapsedMs: number;
  /** Present only for a span that encloses execution; absence means preparation. */
  kind?: StageTimingKind;
};
export type StageTimingSummary = { totalMs: number; stages: StageTiming[] };

/** Records checkpoints and explicit spans without owning logging policy. */
export function createStageTimingTracker(now: () => number = () => Date.now()) {
  const startedAt = now();
  let previousAt = startedAt;
  const stages: StageTiming[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number, kind?: StageTimingKind) => {
    const currentAt = now();
    stages.push({
      name,
      durationMs: toMs(currentAt - spanStartedAt),
      elapsedMs: toMs(currentAt - startedAt),
      ...(kind ? { kind } : {}),
    });
    return currentAt;
  };
  return {
    mark: (name: string) => {
      previousAt = record(name, previousAt);
    },
    measure: async <T>(
      name: string,
      run: () => Promise<T> | T,
      kind?: StageTimingKind,
    ): Promise<T> => {
      const spanStartedAt = now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt, kind);
      }
    },
    measureSync: <T>(name: string, run: () => T, kind?: StageTimingKind): T => {
      const spanStartedAt = now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt, kind);
      }
    },
    snapshot: (): StageTimingSummary => {
      return { totalMs: toMs(now() - startedAt), stages: stages.slice() };
    },
  };
}

/** Formats timing entries without choosing the caller's prefix or field label. */
export function formatStageTimings(stages: readonly StageTiming[]): string {
  return stages.length > 0
    ? stages.map((stage) => `${stage.name}:${stage.durationMs}ms@${stage.elapsedMs}ms`).join(",")
    : "none";
}
