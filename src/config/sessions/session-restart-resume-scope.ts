import type { InternalSessionEntry } from "./types.js";

type RestartResumeMarker = NonNullable<InternalSessionEntry["resumeAfterRestart"]>;

export type PendingSessionShellCalls = {
  runId: string;
  calls: { callId: string; key: string }[];
  notice?: {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string | number;
    replyToId?: string;
    operatorSource?: RestartResumeMarker["operatorSource"];
  };
};

/**
 * An opaque token chosen by the supervisor. Shutdown stamps restart markers and run starts
 * stamp the session with the current scope; startup resumes only work from the same scope,
 * so a supervisor that ends work on purpose (for example an explicit stop) starts the next
 * Gateway with a new token.
 */
const GATEWAY_RESTART_RESUME_SCOPE_ENV = "OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE";

export function resolveRestartResumeScope(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[GATEWAY_RESTART_RESUME_SCOPE_ENV]?.trim() || undefined;
}

/** Shutdown-written and recovered markers carry the scope of the Gateway that wrote them. */
export function createRestartResumeMarker(
  marker: Omit<RestartResumeMarker, "scope">,
  scope = resolveRestartResumeScope(),
): RestartResumeMarker {
  return scope ? { ...marker, scope } : { ...marker };
}

/**
 * A new execution supplies its own evidence. A second shutdown before admission may
 * keep the original source only while the supervisor's restart scope still matches.
 */
export function createLiveRestartResumeMarker(
  entry: Pick<
    InternalSessionEntry,
    "lifecycleRunId" | "lifecycleRestartScope" | "resumeAfterRestart"
  >,
  { sourceRunId: liveRunId, ...marker }: Omit<RestartResumeMarker, "scope">,
): RestartResumeMarker {
  const scope = resolveRestartResumeScope();
  let sourceRunId = liveRunId;
  if (!entry.lifecycleRunId && !isRestartResumeEntryOutOfScope(entry, scope)) {
    sourceRunId = entry.resumeAfterRestart?.sourceRunId;
  } else if (sourceRunId !== entry.lifecycleRunId) {
    sourceRunId = undefined;
  }
  return createRestartResumeMarker(
    {
      ...marker,
      ...(sourceRunId ? { sourceRunId } : {}),
      operatorSource: marker.operatorSource ?? entry.resumeAfterRestart?.operatorSource,
    },
    scope,
  );
}

/**
 * Work interrupted under another scope was ended by the supervisor and never resumes. A
 * shutdown marker names its scope; without one, the scope the latest run started under does.
 */
export function isRestartResumeEntryOutOfScope(
  entry: Pick<InternalSessionEntry, "resumeAfterRestart" | "lifecycleRestartScope">,
  scope = resolveRestartResumeScope(),
): boolean {
  return (
    (entry.resumeAfterRestart ? entry.resumeAfterRestart.scope : entry.lifecycleRestartScope) !==
    scope
  );
}

/** A shutdown marker can recover only shell calls made by its original backend execution. */
export function selectPendingRestartShellCalls(
  entry: InternalSessionEntry,
  marker: RestartResumeMarker,
) {
  return marker.sourceRunId && marker.sourceRunId === entry.pendingShellCalls?.runId
    ? entry.pendingShellCalls
    : undefined;
}
