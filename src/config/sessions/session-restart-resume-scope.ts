import type { InternalSessionEntry } from "./types.js";

type RestartResumeMarker = NonNullable<InternalSessionEntry["resumeAfterRestart"]>;

/**
 * An opaque token chosen by the supervisor. Shutdown stamps restart markers with the
 * current scope; startup resumes only markers from the same scope, so a supervisor
 * that ends work on purpose (for example an explicit stop) starts the next Gateway
 * with a new token.
 */
const GATEWAY_RESTART_RESUME_SCOPE_ENV = "OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE";

function resolveRestartResumeScope(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[GATEWAY_RESTART_RESUME_SCOPE_ENV]?.trim() || undefined;
}

/** Shutdown-written markers carry the scope of the Gateway that wrote them. */
export function createRestartResumeMarker(
  marker: Omit<RestartResumeMarker, "scope">,
  scope = resolveRestartResumeScope(),
): RestartResumeMarker {
  return scope ? { ...marker, scope } : { ...marker };
}

/** Work interrupted under another scope was ended by the supervisor and never resumes. */
export function isRestartResumeMarkerOutOfScope(
  marker: RestartResumeMarker | undefined,
  scope = resolveRestartResumeScope(),
): boolean {
  return marker !== undefined && marker.scope !== scope;
}
