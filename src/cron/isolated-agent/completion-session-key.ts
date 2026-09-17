/** Selects a distinct source session only for cron runs that execute detached. */
export function resolveCronExecCompletionSessionKey(params: {
  usesDetachedRunSession: boolean;
  runSessionKey: string;
  completionSessionKey?: string;
}): string | undefined {
  const completionSessionKey = params.completionSessionKey?.trim();
  if (
    !params.usesDetachedRunSession ||
    !completionSessionKey ||
    completionSessionKey === params.runSessionKey
  ) {
    return undefined;
  }
  return completionSessionKey;
}

export function resolveCronExecCompletionSession(params: {
  usesDetachedRunSession: boolean;
  runSessionKey: string;
  completionSessionKey?: string;
  sessionStore: Record<string, { sessionId: string; lifecycleRevision?: string } | undefined>;
}): {
  sessionKey?: string;
  generation?: { sessionId: string; lifecycleRevision?: string };
} {
  const sessionKey = resolveCronExecCompletionSessionKey(params);
  const entry = sessionKey ? params.sessionStore[sessionKey] : undefined;
  return entry
    ? {
        sessionKey,
        generation: {
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
        },
      }
    : {};
}
