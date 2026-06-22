import type { DiagnosticClientContext } from "./diagnostic-client-context.js";
import { areDiagnosticsEnabledForProcess } from "./diagnostic-events.js";

/**
 * Run-scoped store for caller-supplied diagnostic context, keyed by the run's
 * `runId`. The gateway seeds a run's normalized context here at admission; the
 * run's lifecycle emitters (`session.state`, `message.queued`) resolve it back by
 * the same `runId` so each run's events carry only its own attribution.
 *
 * Keying by `runId` — rather than a shared per-session slot — is what makes two
 * differently attributed requests on the same session safe: a later admission
 * writes a different key and cannot overwrite an in-flight run's context.
 *
 * Entries are released authoritatively by the gateway when a run's dispatch
 * settles (success, failure, or rejection — see dispatchAgentRunFromGateway),
 * with the run's idle/replacement lifecycle as a prompt-release optimization.
 * The size cap is a last-resort backstop for a run whose dispatch never settles;
 * it evicts the oldest-inserted entry so the map cannot grow without bound.
 * Eviction degrades to no attribution (resolves to undefined) for that run — it
 * never misattributes one run's context to another, since keys are distinct.
 */
const MAX_TRACKED_RUNS = 1024;

const runClientContext = new Map<string, DiagnosticClientContext>();

export function setRunClientContext(
  runId: string,
  clientContext: DiagnosticClientContext | undefined,
): void {
  // Never retain caller-supplied context when diagnostics are off — there are no
  // consumers, and the idle-clear path that would release it never runs. Matches
  // the guard the removed setDiagnosticSessionClientContext carried.
  if (!areDiagnosticsEnabledForProcess()) {
    return;
  }
  if (!runId) {
    return;
  }
  if (!clientContext) {
    // No (or out-of-bounds) context for this run: ensure no stale value lingers
    // under this runId. runIds are unique per run, so this only matters if the
    // same id is seeded twice (e.g. retried admission).
    runClientContext.delete(runId);
    return;
  }
  if (!runClientContext.has(runId) && runClientContext.size >= MAX_TRACKED_RUNS) {
    const oldest = runClientContext.keys().next().value;
    if (oldest !== undefined) {
      runClientContext.delete(oldest);
    }
  }
  runClientContext.set(runId, clientContext);
}

export function getRunClientContext(
  runId: string | undefined,
): DiagnosticClientContext | undefined {
  if (!runId) {
    return undefined;
  }
  return runClientContext.get(runId);
}

export function clearRunClientContext(runId: string | undefined): void {
  if (!runId) {
    return;
  }
  runClientContext.delete(runId);
}

export function resetRunClientContextForTest(): void {
  runClientContext.clear();
}
