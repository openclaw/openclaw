type SessionRefMarker = {
  sessionId?: string;
  sessionKey?: string;
};

type SessionRefActivity = SessionRefMarker & {
  sessionRefs: Set<string>;
  activeRuns: Map<string, { sessionId?: string }>;
  activeReplyOperations: Set<string>;
  activeEmbeddedRuns: Map<string, SessionRefMarker>;
  activeTools: Map<string, SessionRefMarker>;
  activeModelCalls: Map<string, SessionRefMarker>;
  recoveredOwnerStartEventCutoffs: Map<string, number>;
};

const SESSION_ACTIVITY_MAX_REFS = 2_000;

export function diagnosticSessionRefs(params: {
  sessionId?: string;
  sessionKey?: string;
}): string[] {
  const refs: string[] = [];
  const sessionId = params.sessionId?.trim();
  const sessionKey = params.sessionKey?.trim();
  if (sessionId) {
    refs.push(`id:${sessionId}`);
  }
  if (sessionKey) {
    refs.push(`key:${sessionKey}`);
  }
  return refs;
}

export function diagnosticToolActivityKey(event: {
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  toolCallId?: string;
  toolName: string;
}): string {
  return `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${
    event.toolCallId ?? event.toolName
  }`;
}

export function diagnosticModelCallActivityKey(event: {
  runId?: string;
  provider?: string;
  model?: string;
}): string {
  return `${event.runId ?? "unknown"}:${event.provider ?? "provider"}:${event.model ?? "model"}`;
}

function protectedSessionActivityRefs(activity: SessionRefActivity): Set<string> {
  const refs = new Set(diagnosticSessionRefs(activity));
  for (const activeRun of activity.activeRuns.values()) {
    for (const ref of diagnosticSessionRefs({ sessionId: activeRun.sessionId })) {
      refs.add(ref);
    }
  }
  for (const sessionKey of activity.activeReplyOperations) {
    refs.add(`key:${sessionKey}`);
  }
  for (const markers of [
    activity.activeEmbeddedRuns,
    activity.activeTools,
    activity.activeModelCalls,
  ]) {
    for (const marker of markers.values()) {
      for (const ref of diagnosticSessionRefs(marker)) {
        refs.add(ref);
      }
    }
  }
  for (const ownerRef of activity.recoveredOwnerStartEventCutoffs.keys()) {
    const ref = `id:${ownerRef}`;
    if (activity.sessionRefs.has(ref)) {
      refs.add(ref);
    }
  }
  return refs;
}

export function createDiagnosticSessionActivityRefStore<Activity extends SessionRefActivity>(
  activityByRef: Map<string, Activity>,
  activities: Set<Activity>,
) {
  function prune(activity: Activity): void {
    let excess = activity.sessionRefs.size - SESSION_ACTIVITY_MAX_REFS;
    if (excess <= 0) {
      return;
    }
    const protectedRefs = protectedSessionActivityRefs(activity);
    for (const ref of activity.sessionRefs) {
      if (protectedRefs.has(ref)) {
        continue;
      }
      activity.sessionRefs.delete(ref);
      if (activityByRef.get(ref) === activity) {
        activityByRef.delete(ref);
      }
      excess -= 1;
      if (excess <= 0) {
        return;
      }
    }
  }

  return {
    delete(activity: Activity): void {
      for (const ref of activity.sessionRefs) {
        if (activityByRef.get(ref) === activity) {
          activityByRef.delete(ref);
        }
      }
      activities.delete(activity);
    },
    prune,
    register(
      activity: Activity,
      params: { sessionId?: string; sessionKey?: string },
      trackCurrent = true,
    ): void {
      activities.add(activity);
      if (trackCurrent) {
        activity.sessionId = params.sessionId?.trim() || activity.sessionId;
        activity.sessionKey = params.sessionKey?.trim() || activity.sessionKey;
      }
      for (const ref of diagnosticSessionRefs(params)) {
        activity.sessionRefs.delete(ref);
        activity.sessionRefs.add(ref);
        activityByRef.set(ref, activity);
      }
      prune(activity);
    },
    replace(source: Activity, target: Activity): void {
      for (const ref of source.sessionRefs) {
        target.sessionRefs.delete(ref);
        target.sessionRefs.add(ref);
        activityByRef.set(ref, target);
      }
    },
  };
}
