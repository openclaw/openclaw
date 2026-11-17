import type { InternalSessionEntry } from "./types.js";

type RestartResumeMarker = NonNullable<InternalSessionEntry["resumeAfterRestart"]>;

/**
 * A supervisor that starts a new deployment generation (for example after an
 * explicit stop) sets a new scope. Shutdown stamps restart markers with the
 * current scope; startup resumes only markers from the same scope.
 */
export const GATEWAY_RESTART_RESUME_SCOPE_ENV = "OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE";

export function resolveRestartResumeScope(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[GATEWAY_RESTART_RESUME_SCOPE_ENV]?.trim() || undefined;
}

/** Shutdown-written markers carry the scope of the Gateway that wrote them. */
export function createRestartResumeMarker(
  marker: Omit<RestartResumeMarker, "scope">,
  scope = resolveRestartResumeScope(),
): RestartResumeMarker {
  return scope ? { ...marker, scope } : { ...marker };
}

/** Work interrupted under another scope belongs to an ended generation and never resumes. */
export function isRestartResumeMarkerInScope(
  marker: RestartResumeMarker,
  scope = resolveRestartResumeScope(),
): boolean {
  return marker.scope === scope;
}
