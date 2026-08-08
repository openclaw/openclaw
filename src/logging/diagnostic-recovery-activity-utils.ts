type ActivityMarker = {
  runId?: string;
  sessionId?: string;
  sequence?: number;
};

type EmbeddedRunMarker = {
  sessionId?: string;
  sequence: number;
};

export function ownerRefsForRecovery(params: {
  sessionId?: string;
  activeSessionId?: string;
}): Set<string> {
  const refs = [params.activeSessionId?.trim(), params.sessionId?.trim()].filter(
    (ref): ref is string => Boolean(ref),
  );
  return new Set(refs);
}

export function ownerRefsForStartedEvent(event: { runId?: string; sessionId?: string }): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
}

export function markerBelongsToRecoveredOwner(
  marker: ActivityMarker,
  ownerRefs: Set<string>,
): boolean {
  return (
    (marker.runId !== undefined && ownerRefs.has(marker.runId)) ||
    (marker.sessionId !== undefined && ownerRefs.has(marker.sessionId))
  );
}

export function embeddedRunStartedAfter(
  embeddedRun: EmbeddedRunMarker,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && embeddedRun.sequence > sequence;
}

export function activityMarkerStartedAfter(
  marker: ActivityMarker,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && marker.sequence !== undefined && marker.sequence > sequence;
}

export function hasActivityMarkerStartedAfter(
  activity: {
    activeTools: ReadonlyMap<string, ActivityMarker>;
    activeModelCalls: ReadonlyMap<string, ActivityMarker>;
  },
  sequence: number | undefined,
): boolean {
  if (sequence === undefined) {
    return false;
  }
  return [...activity.activeTools.values(), ...activity.activeModelCalls.values()].some((marker) =>
    activityMarkerStartedAfter(marker, sequence),
  );
}
