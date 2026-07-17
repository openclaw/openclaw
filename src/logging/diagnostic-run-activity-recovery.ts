type RecoveryOwnerParams = {
  sessionId?: string;
  activeSessionId?: string;
};

type OwnedActivityMarker = {
  runId?: string;
  sessionId?: string;
};

type SequencedActivityMarker = {
  sequence?: number;
};

export function recoveryOwnerRefs(params: RecoveryOwnerParams): Set<string> {
  const refs = [params.activeSessionId?.trim(), params.sessionId?.trim()].filter(
    (ref): ref is string => Boolean(ref),
  );
  return new Set(refs);
}

export function startedEventOwnerRefs(event: OwnedActivityMarker): string[] {
  return [event.runId?.trim(), event.sessionId?.trim()].filter((ref): ref is string =>
    Boolean(ref),
  );
}

export function activityMarkerBelongsToOwner(
  marker: OwnedActivityMarker,
  ownerRefs: Set<string>,
): boolean {
  return (
    (marker.runId !== undefined && ownerRefs.has(marker.runId)) ||
    (marker.sessionId !== undefined && ownerRefs.has(marker.sessionId))
  );
}

export function activityMarkerStartedAfter(
  marker: SequencedActivityMarker,
  sequence: number | undefined,
): boolean {
  return sequence !== undefined && marker.sequence !== undefined && marker.sequence > sequence;
}
