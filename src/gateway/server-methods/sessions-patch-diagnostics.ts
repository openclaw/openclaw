import { performance } from "node:perf_hooks";
import {
  SESSIONS_PATCH_MANY_MAX_TARGETS,
  SessionsPatchMutationSchema,
  type SessionsPatchMutation,
} from "../../../packages/gateway-protocol/src/schema/sessions-patch.js";
import { createPhaseTimings } from "./phase-timings.js";
import { sessionLog } from "./sessions-shared.js";

const SLOW_SESSION_PATCH_MS = 1_000;
const PHASES = [
  "preflight",
  "archive",
  "lifecycleAdmission",
  "snapshot",
  "projection",
  "catalog",
  "runtimeSelection",
  "archivePlacement",
  "worktree",
  "commit",
  "permissions",
  "lifecycleFinalize",
  "cleanup",
  "effects",
  "cronEffects",
  "response",
] as const;
type SessionPatchPhase = (typeof PHASES)[number];

export type SessionPatchDiagnostics = ReturnType<typeof startSessionPatchDiagnostics>;

/** Fixed, request-owned elapsed totals. Parallel and nested phases can overlap. */
export function startSessionPatchDiagnostics(method: "sessions.patch" | "sessions.patchMany") {
  const startedAt = performance.now();
  const timing = createPhaseTimings<SessionPatchPhase>();
  let finished = false;
  let requestDetails = "";
  return {
    describeRequest(targetCount: number, patch: SessionsPatchMutation) {
      const fields = Object.entries(patch)
        .filter(
          ([key, value]) =>
            value !== undefined && Object.hasOwn(SessionsPatchMutationSchema.properties, key),
        )
        .map(([key]) => key)
        .toSorted();
      const names =
        fields.slice(0, 8).join(",") + (fields.length > 8 ? `,+${fields.length - 8}` : "");
      requestDetails = ` targets=${Math.min(targetCount, SESSIONS_PATCH_MANY_MAX_TARGETS)} fields=${names || "none"}`;
    },
    scope: (phase: SessionPatchPhase) => (finished ? undefined : timing.scope(phase)),
    finish() {
      if (finished) {
        return;
      }
      // Exceptions close unfinished scopes; no timer or process-global request state survives.
      timing.flush(performance.now());
      timing.close();
      finished = true;
      const elapsedMs = performance.now() - startedAt;
      if (elapsedMs < SLOW_SESSION_PATCH_MS) {
        return;
      }
      try {
        // Message text survives transports that omit structured fields; the logger retains trace context.
        let message = `slow session patch ${Math.round(elapsedMs)}ms method=${method}${requestDetails}`;
        for (const phase of PHASES) {
          const total = timing.totals.get(phase);
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
