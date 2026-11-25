import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type TranscriptDisplayPosition = {
  source: string;
  rawSeq: number;
  activity?: { afterRawSeq: number | null; scopeId: string; startOrder: number };
};

function isOrdinal(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    (value.length <= limit || Array.from(value).length <= limit)
  );
}

/** Public placement metadata is bounded and never supplies execution authority. */
export function readTranscriptDisplayPosition(
  value: unknown,
): TranscriptDisplayPosition | undefined {
  const record = asOptionalRecord(value);
  if (!record || !isIdentifier(record.source, 128) || !isOrdinal(record.rawSeq)) {
    return undefined;
  }
  if (record.activity === undefined) {
    return {
      source: record.source,
      rawSeq: record.rawSeq,
      ...("activity" in record ? { activity: undefined } : {}),
    };
  }
  const activity = asOptionalRecord(record.activity);
  if (
    !activity ||
    (activity.afterRawSeq !== null &&
      (!isOrdinal(activity.afterRawSeq) || activity.afterRawSeq >= record.rawSeq)) ||
    !isIdentifier(activity.scopeId, 1024) ||
    !isOrdinal(activity.startOrder)
  ) {
    return undefined;
  }
  return {
    source: record.source,
    rawSeq: record.rawSeq,
    activity: {
      afterRawSeq: activity.afterRawSeq,
      scopeId: activity.scopeId,
      startOrder: activity.startOrder,
    },
  };
}

/** Recompose presentation after pages/events merge, without changing physical cursor order. */
export function composeTranscriptDisplay<T>(
  values: T[],
  messageFor: (value: T) => unknown = (value) => value,
): T[] {
  const output: T[] = [];
  let start = 0;
  let positions: TranscriptDisplayPosition[] = [];
  let activities: number[] = [];
  let previousStableSeq: number | undefined;
  let monotonic = true;
  const flush = () => {
    if (positions.length === 0) {
      return;
    }
    const current = positions;
    const activityIndexes = activities;
    const recompose = monotonic && activityIndexes.length > 0;
    positions = [];
    activities = [];
    previousStableSeq = undefined;
    monotonic = true;
    if (!recompose) {
      return;
    }
    // Positions index the collected output tail. Detach only segments that need
    // recomposition, preserving each value captured by the message selector.
    const selected = output.splice(start);
    const ordered = activityIndexes.toSorted((left, right) => {
      const a = current[left]!.activity!.afterRawSeq;
      const b = current[right]!.activity!.afterRawSeq;
      if (a === b) {
        return current[left]!.rawSeq - current[right]!.rawSeq;
      }
      if (a === null) {
        return -1;
      }
      return b === null ? 1 : a - b;
    });
    let next = 0;
    const emitGap = (beforeRawSeq?: number) => {
      let cohorts: Map<string, { firstSeq: number; rows: number[] }> | undefined;
      while (next < ordered.length) {
        const index = ordered[next]!;
        const position = current[index]!;
        const activity = position.activity!;
        if (
          beforeRawSeq !== undefined &&
          activity.afterRawSeq !== null &&
          activity.afterRawSeq >= beforeRawSeq
        ) {
          break;
        }
        cohorts ??= new Map();
        let cohort = cohorts.get(activity.scopeId);
        if (!cohort) {
          cohort = { firstSeq: position.rawSeq, rows: [] };
          cohorts.set(activity.scopeId, cohort);
        }
        cohort.firstSeq = Math.min(cohort.firstSeq, position.rawSeq);
        cohort.rows.push(index);
        next += 1;
      }
      if (!cohorts) {
        return;
      }
      // Scope cohorts keep a total order; comparing ordinals only for matching
      // scopes inside one comparator would be non-transitive across attempts.
      for (const cohort of [...cohorts.values()].toSorted((a, b) => a.firstSeq - b.firstSeq)) {
        const sorted = cohort.rows.toSorted(
          (a, b) =>
            current[a]!.activity!.startOrder - current[b]!.activity!.startOrder ||
            current[a]!.rawSeq - current[b]!.rawSeq,
        );
        for (const index of sorted) {
          output.push(selected[index]!);
        }
      }
    };
    for (let index = 0; index < current.length; index += 1) {
      const position = current[index]!;
      if (!position.activity) {
        emitGap(position.rawSeq);
        output.push(selected[index]!);
      }
    }
    emitGap();
  };
  for (const value of values) {
    const metadata = asOptionalRecord(asOptionalRecord(messageFor(value))?.["__openclaw"]);
    const position = readTranscriptDisplayPosition(metadata?.transcriptPosition);
    // Optimistic/uncoordinated rows and different rewrite generations are causal
    // barriers. A later canonical snapshot can place them; timestamps cannot.
    if (!position) {
      flush();
      output.push(value);
      start = output.length;
      continue;
    }
    if (positions.at(-1)?.source !== position.source) {
      flush();
      start = output.length;
    }
    if (position.activity) {
      activities.push(positions.length);
    } else {
      monotonic &&= previousStableSeq === undefined || previousStableSeq <= position.rawSeq;
      previousStableSeq = position.rawSeq;
    }
    positions.push(position);
    output.push(value);
  }
  flush();
  return output.every((value, index) => value === values[index]) ? values : output;
}
