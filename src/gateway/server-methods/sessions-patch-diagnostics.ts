import { performance } from "node:perf_hooks";
import { sessionLog } from "./sessions-shared.js";

const SLOW_SESSION_PATCH_MS = 1_000;
const PHASES = [
  "preflight",
  "archive",
  "lifecycleAdmission",
  "snapshot",
  "projection",
  "catalog",
  "worktree",
  "commit",
  "worktreeCleanup",
  "permissions",
  "lifecycleFinalize",
  "cleanup",
  "effects",
  "response",
] as const;
type SessionPatchPhase = (typeof PHASES)[number];
type PhaseScope = { mark: (phase?: SessionPatchPhase) => void; finish: () => void };

export type SessionPatchDiagnostics = ReturnType<typeof startSessionPatchDiagnostics>;

/** Fixed, request-owned elapsed totals. Parallel and nested phases can overlap. */
export function startSessionPatchDiagnostics(method: "sessions.patch" | "sessions.patchMany") {
  const startedAt = performance.now();
  const totals = new Map<SessionPatchPhase, number>();
  const scopes = new Set<PhaseScope>();
  let finished = false;
  return {
    scope(initialPhase: SessionPatchPhase): PhaseScope | undefined {
      if (finished) {
        return undefined;
      }
      let phase: SessionPatchPhase | undefined = initialPhase;
      let phaseStartedAt = performance.now();
      const scope: PhaseScope = {
        mark(nextPhase) {
          if (!scopes.has(scope)) {
            return;
          }
          const now = performance.now();
          if (phase) {
            totals.set(phase, (totals.get(phase) ?? 0) + now - phaseStartedAt);
          }
          phase = nextPhase;
          phaseStartedAt = now;
        },
        finish() {
          scope.mark();
          scopes.delete(scope);
        },
      };
      scopes.add(scope);
      return scope;
    },
    finish() {
      if (finished) {
        return;
      }
      // Exceptions close unfinished scopes; no timer or process-global request state survives.
      for (const scope of scopes) {
        scope.finish();
      }
      finished = true;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs < SLOW_SESSION_PATCH_MS) {
        return;
      }
      try {
        // Message text survives transports that omit structured fields; the logger retains trace context.
        let message = `slow session patch ${Math.round(elapsedMs)}ms method=${method}`;
        for (const phase of PHASES) {
          const total = totals.get(phase);
          if (total !== undefined) {
            message += ` ${phase}=${Math.round(total)}ms`;
          }
        }
        sessionLog.info(message);
      } catch {
        // A diagnostic sink must not replace the mutation's result or original error.
      }
    },
  };
}
