import type { InternalSessionEntry } from "./types.js";

type RestartResumeMarker = NonNullable<InternalSessionEntry["resumeAfterRestart"]>;

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
