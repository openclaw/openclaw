import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

/** The lifecycle owner supplies its captured target, never a later reread of a session key. */
export type PreparedSessionRun = Readonly<{
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string | null;
  runId: string;
}>;

// Source tools and the published Gateway must recognize the same host-owned request.
const runs = resolveGlobalSingleton<WeakMap<object, PreparedSessionRun>>(
  Symbol.for("openclaw.inProcessSessionRuns"),
  () => new WeakMap(),
);

export function bindInProcessSessionRun(
  request: Record<string, unknown>,
  launch: PreparedSessionRun,
): Record<string, unknown> {
  if (request.sessionKey !== launch.sessionKey || request.idempotencyKey !== launch.runId) {
    throw new Error("Session run does not match its prepared target");
  }
  const bound = {
    ...request,
    expectedExistingSessionId: launch.sessionId,
    expectedExistingSessionLifecycleRevision: launch.lifecycleRevision,
  };
  runs.set(bound, { ...launch });
  return bound;
}

/** Wire fields cannot grant this alternative; live source and own-session checks still apply. */
export function isInProcessSessionRun(method: string, params: unknown): boolean {
  const request = asOptionalRecord(params);
  const launch = method === "agent" && request ? runs.get(request) : undefined;
  return Boolean(
    launch &&
    request?.sessionKey === launch.sessionKey &&
    request.idempotencyKey === launch.runId &&
    request.expectedExistingSessionId === launch.sessionId &&
    request.expectedExistingSessionLifecycleRevision === launch.lifecycleRevision,
  );
}
